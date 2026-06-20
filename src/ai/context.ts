// ── CONVERSATION CONTEXT BUILDER ──────────────────────────────
//
// Loads the communication profile, recent message history, and
// conversation state needed to call the AI. Returns everything
// the AI worker needs in one DB round-trip (adminDb — bypasses RLS).

import { adminDb } from '../db/client.js'
import { estimateSentiment } from './classifier.js'
import type { ChatMessage, ConversationSignals } from '../interfaces/ai.js'

// ── DB row types ──────────────────────────────────────────────

type ProfileVersionRow = {
  persona:             string
  tone:               string
  permitted_topics:   string[]
  prohibited_topics:  string[]
  escalation_triggers: string[]
  system_prompt:      string
}

type ConversationRow = {
  profile_version_id: string
  total_turns:        string
  context_summary:    string | null
  ai_active:          boolean
  status:             string
  escalated_at:       string | null
}

type MessageRow = {
  direction: 'inbound' | 'outbound'
  content:   string
}

// ── Exported types ─────────────────────────────────────────────

export interface ConversationContext {
  messages:             ChatMessage[]
  signals:              ConversationSignals
  profileVersionId:     string
  escalationTriggers:   string[]
  prohibitedTopics:     string[]
  aiActive:             boolean
  conversationStatus:   string
  latestInboundContent: string
}

// ── Implementation ────────────────────────────────────────────

// Rough token estimate — 4 chars per token is close enough for English.
function estimateTokens(texts: string[]): number {
  return Math.ceil(texts.reduce((sum, t) => sum + t.length, 0) / 4)
}

// Build system prompt from profile fields.
function buildSystemPrompt(p: ProfileVersionRow): string {
  const parts = [
    `You are ${p.persona}. Your communication style is ${p.tone}.`,
    p.system_prompt,
  ]

  if (p.permitted_topics.length > 0) {
    parts.push(`You may only discuss: ${p.permitted_topics.join(', ')}.`)
  }
  if (p.prohibited_topics.length > 0) {
    parts.push(`Never discuss or reference: ${p.prohibited_topics.join(', ')}.`)
  }
  if (p.escalation_triggers.length > 0) {
    parts.push(
      `If the contact mentions any of the following, say you are connecting them with ` +
      `a team member and stop responding: ${p.escalation_triggers.join(', ')}.`,
    )
  }

  parts.push('Keep responses concise and conversational. This is WhatsApp — avoid long paragraphs.')

  return parts.join('\n\n')
}

export async function buildConversationContext(
  conversationId: string,
  clientId: string,
): Promise<ConversationContext | null> {
  // Load conversation
  const convRows = (await adminDb`
    SELECT profile_version_id, total_turns, context_summary,
           ai_active, status, escalated_at
    FROM   conversations
    WHERE  id = ${conversationId} AND client_id = ${clientId}
  `) as unknown as ConversationRow[]

  const conv = convRows[0]
  if (!conv) return null

  // Load profile version
  const profRows = (await adminDb`
    SELECT persona, tone, permitted_topics, prohibited_topics,
           escalation_triggers, system_prompt
    FROM   communication_profile_versions
    WHERE  id = ${conv.profile_version_id}
  `) as unknown as ProfileVersionRow[]

  const profile = profRows[0]
  if (!profile) return null

  // Load recent messages — last 20 ordered ASC so history reads naturally
  const msgRows = (await adminDb`
    SELECT direction, content
    FROM   messages
    WHERE  conversation_id = ${conversationId}
      AND  status != 'failed'
    ORDER BY created_at DESC
    LIMIT 20
  `) as unknown as MessageRow[]

  // Reverse to chronological order
  const recentMessages = [...msgRows].reverse()

  // Latest inbound is the message that triggered this job
  // findLast not available at current lib target — search from the end manually
  let latestInboundContent = ''
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    if (recentMessages[i]?.direction === 'inbound') {
      latestInboundContent = recentMessages[i]?.content ?? ''
      break
    }
  }

  // Build ChatMessage array
  const chatMessages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(profile) },
  ]

  // If the conversation has a summary from a prior compression, include it
  if (conv.context_summary) {
    chatMessages.push({
      role:    'system',
      content: `Previous conversation summary:\n${conv.context_summary}`,
    })
  }

  for (const m of recentMessages) {
    chatMessages.push({
      role:    m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.content,
    })
  }

  // Build signals
  const turnCount     = parseInt(conv.total_turns, 10)
  const contentTexts  = recentMessages.map(m => m.content)
  const contextTokens = estimateTokens(contentTexts)

  const hasEscalationKeywords = profile.escalation_triggers.some(trigger =>
    latestInboundContent.toLowerCase().includes(trigger.toLowerCase()),
  )
  const hasFlaggedTopics = profile.prohibited_topics.some(topic =>
    latestInboundContent.toLowerCase().includes(topic.toLowerCase()),
  )
  const sentimentScore   = estimateSentiment(latestInboundContent)
  const priorEscalations = conv.escalated_at ? 1 : 0

  return {
    messages:             chatMessages,
    signals:              { turnCount, contextTokens, hasEscalationKeywords,
                            hasFlaggedTopics, sentimentScore, priorEscalations },
    profileVersionId:     conv.profile_version_id,
    escalationTriggers:   profile.escalation_triggers,
    prohibitedTopics:     profile.prohibited_topics,
    aiActive:             conv.ai_active,
    conversationStatus:   conv.status,
    latestInboundContent,
  }
}
