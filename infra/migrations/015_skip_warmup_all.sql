-- Remove warmup limits for all existing and future sessions.
-- Running on phone (residential IP) means ban risk is low enough
-- that daily caps only block legitimate business sends.
UPDATE warmup_profiles SET skip_warmup = true WHERE skip_warmup = false;
