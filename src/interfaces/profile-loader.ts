import type { ResolvedProfile } from '../db/schema/index.js'

// ── COMMUNICATION PROFILE LOADER INTERFACE ────────────────────
//
// Every AI call loads a communication profile as its system prompt.
// The loader handles the three-level architecture (default → light →
// full control), profile version pinning to conversations, and
// {business_name} template substitution.

export interface ProfileLoadOptions {
  // The business name substituted into {business_name} in the system prompt
  businessName: string
  // Warmup stage — injected as an additional constraint into the system prompt
  // when the session is still warming up
  warmupGuidance?: 'conversational' | 'light_cta' | 'unrestricted'
}

export interface ICommunicationProfileLoader {
  // Load the profile version pinned to this conversation.
  // Used for all mid-conversation AI calls — the profile never changes
  // during a conversation's lifetime.
  forConversation(
    conversationId: string,
    options: ProfileLoadOptions,
  ): Promise<ResolvedProfile>

  // Load the current active profile for a client.
  // Used when starting a new conversation.
  forClient(
    clientId: string,
    options: ProfileLoadOptions,
  ): Promise<ResolvedProfile>

  // Load the seeded default profile for a business category.
  // Used at client signup before any profile customisation exists.
  defaultForCategory(
    categorySlug: string,
    options: ProfileLoadOptions,
  ): Promise<ResolvedProfile>
}
