from __future__ import annotations
import os
import json
import re
import sys
import asyncio
import time
from typing import Any
from groq import Groq
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from datetime import datetime

# Load environment variables
load_dotenv()

# Ensure console logging won't crash on Windows code pages (e.g. cp1252).
try:
    _reconfigure_stdout = getattr(sys.stdout, "reconfigure", None)
    if _reconfigure_stdout:
        _reconfigure_stdout(encoding="utf-8", errors="replace")
    _reconfigure_stderr = getattr(sys.stderr, "reconfigure", None)
    if _reconfigure_stderr:
        _reconfigure_stderr(encoding="utf-8", errors="replace")
except Exception:
    pass


def _safe_preview(text: str | None, limit: int = 200) -> str:
    """Return an ASCII-only preview safe for Windows consoles."""
    t = (text or "")[:limit]
    return t.encode("ascii", "backslashreplace").decode("ascii")


def _retry_on_rate_limit(func, max_retries: int = 3, base_delay: float = 5.0):
    """Retry function on Groq rate limit errors with exponential backoff."""
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as e:
            error_msg = str(e).lower()
            if "rate_limit" in error_msg or "429" in error_msg:
                if attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt)
                    print(f"[GROQ RETRY] Rate limit hit, waiting {delay:.1f}s (attempt {attempt + 1}/{max_retries})...")
                    time.sleep(delay)
                    continue
            raise


def is_valid_reply(text: str) -> bool:
    """Check if a reply is valid and safe to send."""
    if not text or not text.strip():
        return False
    
    t = text.strip()
    
    # Too short
    if len(t) < 2:
        return False
    
    # Only meta text (should not be sent)
    meta_only = {"okay", "ok", "sure", "yes", "no", "hmm", "huh"}
    if t.lower() in meta_only:
        return False
    
    # Contains only emojis (might be okay, but let's be safe)
    import re
    emoji_pattern = re.compile(
        "[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF"
        "\U0001F1E0-\U0001F1FF\U00002702-\U000027B0\U000024C2-\U0001F251]+",
        flags=re.UNICODE
    )
    if emoji_pattern.sub("", t).strip() == "":
        return False
    
    return True


class ReplyValidator:
    """
    Smart reply validator that checks quality before sending.
    Similar to RAGAS evaluation but for runtime validation.
    """
    
    # Harmful patterns to block
    HARMFUL_PATTERNS = [
        r"i am an ai",
        r"i'm an ai",
        r"as an ai",
        r"i am a bot",
        r"i'm a bot",
        r"as a bot",
        r"i cannot",
        r"i can't",
        r"i'm not able",
        r"i am not able",
    ]
    
    # Meta phrases that shouldn't be sent as standalone replies
    META_PHRASES = {
        "okay", "ok", "sure", "yes", "no", "hmm", "huh", "oh", "ah",
        "um", "uh", "er", "ah", "wow", "oops", "uhh", "umm",
    }
    
    def __init__(self, groq_client=None, model: str = ""):
        self.groq = groq_client
        self.model = model
    
    def validate(self, reply: str, original_message: str = "") -> dict:
        """
        Validate a reply and return validation result.
        
        Returns:
            {
                "valid": bool,
                "score": float (0-1),
                "issues": list[str],
                "suggestion": str | None
            }
        """
        issues = []
        score = 1.0
        
        # Check 1: Not empty
        if not reply or not reply.strip():
            return {"valid": False, "score": 0.0, "issues": ["empty"], "suggestion": None}
        
        t = reply.strip()
        
        # Check 2: Minimum length
        if len(t) < 2:
            issues.append("too_short")
            score -= 0.5
        
        # Check 3: Not just meta words
        if t.lower() in self.META_PHRASES:
            issues.append("meta_only")
            score -= 0.8
        
        # Check 4: No harmful AI disclosure
        import re
        for pattern in self.HARMFUL_PATTERNS:
            if re.search(pattern, t, re.IGNORECASE):
                issues.append("ai_disclosure")
                score -= 1.0
                break
        
        # Check 5: Not too long (WhatsApp friendly)
        if len(t) > 1000:
            issues.append("too_long")
            score -= 0.3
        
        # Check 6: Relevance check (if original message provided)
        if original_message and self.groq:
            relevance_score = self._check_relevance(t, original_message)
            if relevance_score < 0.3:
                issues.append("low_relevance")
                score -= 0.5
        
        # Clamp score
        score = max(0.0, min(1.0, score))
        
        # Generate suggestion if needed
        suggestion = None
        if score < 0.5 and self.groq:
            suggestion = self._generate_better_reply(original_message)
        
        return {
            "valid": score >= 0.5 and len(issues) == 0,
            "score": score,
            "issues": issues,
            "suggestion": suggestion,
        }
    
    def _check_relevance(self, reply: str, question: str) -> float:
        """Check if reply is relevant to the question using AI."""
        if not self.groq:
            return 0.8  # Default to OK if no AI available
        
        try:
            prompt = f"""Rate how relevant this reply is to the question (0.0 to 1.0).
Only return the number, nothing else.

Question: {question}
Reply: {reply}

Relevance score:"""

            response = self.groq.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
            )
            result = response.choices[0].message.content.strip()
            return float(result)
        except Exception:
            return 0.8  # Default to OK on error
    
    def _generate_better_reply(self, question: str) -> str:
        """Generate a better reply using AI."""
        if not self.groq:
            return None
        
        try:
            prompt = f"""Generate a short, friendly WhatsApp reply to this message.
Keep it under 50 words. Be natural and human-like.

Message: {question}

Reply:"""

            response = self.groq.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.7,
            )
            return response.choices[0].message.content.strip()
        except Exception:
            return None


# Global validator instance
_validator: ReplyValidator | None = None


def get_validator() -> ReplyValidator:
    """Get or create the global reply validator."""
    global _validator
    return _validator


def init_validator(groq_client, model: str):
    """Initialize the global reply validator."""
    global _validator
    _validator = ReplyValidator(groq_client, model)


class ConfidenceScorer:
    """
    Agentic confidence scoring system.
    Evaluates how confident the bot should be before replying.
    """
    
    # High confidence patterns (auto-send)
    HIGH_CONFIDENCE_KEYWORDS = {
        "time", "date", "day", "month", "year",  # Time queries
        "hi", "hello", "hey", "bye", "thanks",    # Greetings
        "ok", "okay", "sure", "yes", "no",        # Simple responses
    }
    
    # Low confidence patterns (needs confirmation)
    LOW_CONFIDENCE_KEYWORDS = {
        "maybe", "perhaps", "i think", "i guess",
        "not sure", "don't know", "unclear",
    }
    
    def __init__(self, groq_client=None, model: str = ""):
        self.groq = groq_client
        self.model = model
    
    def score(self, message: str, reply: str, msg_type: str) -> dict:
        """
        Calculate confidence score for a reply.
        
        Returns:
            {
                "score": float (0-100),
                "level": "high" | "medium" | "low",
                "should_auto_send": bool,
                "reason": str
            }
        """
        score = 70.0  # Default medium confidence
        reasons = []
        
        # Factor 1: Message type
        if msg_type == "time":
            score = 100.0
            reasons.append("time_query")
        elif msg_type == "casual":
            score = 100.0
            reasons.append("casual_message")
        elif msg_type == "factual":
            score = 100.0
            reasons.append("factual_search")
        elif msg_type == "decision":
            score = 30.0
            reasons.append("decision_message")
        
        # Factor 2: Reply quality
        if reply and len(reply.strip()) > 5:
            score += 5.0
            reasons.append("good_length")
        elif reply and len(reply.strip()) < 3:
            score -= 20.0
            reasons.append("too_short")
        
        # Factor 3: Contains question (might need clarification)
        if reply and "?" in reply:
            score -= 10.0
            reasons.append("contains_question")
        
        # Factor 4: AI uncertainty phrases
        if reply:
            lower_reply = reply.lower()
            uncertainty_phrases = ["i think", "maybe", "perhaps", "not sure", "i'm not certain"]
            for phrase in uncertainty_phrases:
                if phrase in lower_reply:
                    score -= 15.0
                    reasons.append("uncertainty_phrase")
                    break
        
        # Factor 5: Length match (short question = short reply expected)
        if message and reply:
            msg_len = len(message.split())
            reply_len = len(reply.split())
            if msg_len <= 3 and reply_len <= 10:
                score += 10.0
                reasons.append("length_match")
        
        # Clamp score
        score = max(0.0, min(100.0, score))
        
        # Determine level
        if score >= 80:
            level = "high"
        elif score >= 50:
            level = "medium"
        else:
            level = "low"
        
        # Should auto-send?
        should_auto_send = score >= 70 and msg_type in ("casual", "factual", "time")
        
        return {
            "score": round(score, 1),
            "level": level,
            "should_auto_send": should_auto_send,
            "reason": ", ".join(reasons) if reasons else "default",
        }
    
    def score_with_ai(self, message: str, reply: str) -> dict:
        """
        Use AI to evaluate confidence (slower but more accurate).
        """
        if not self.groq:
            return self.score(message, reply, "unknown")
        
        try:
            prompt = f"""Rate your confidence in this reply on a scale of 0-100.
Consider: accuracy, appropriateness, safety.

Original message: {message}
Your reply: {reply}

Return ONLY a JSON like: {{"score": 85, "reason": "brief reason"}}"""

            response = self.groq.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
            )
            
            result = response.choices[0].message.content.strip()
            
            # Parse JSON
            import json
            import re
            match = re.search(r'\{[^}]+\}', result)
            if match:
                data = json.loads(match.group())
                score = float(data.get("score", 70))
                reason = data.get("reason", "ai_evaluated")
                
                return {
                    "score": score,
                    "level": "high" if score >= 80 else "medium" if score >= 50 else "low",
                    "should_auto_send": score >= 70,
                    "reason": reason,
                }
        except Exception:
            pass
        
        # Fallback to rule-based scoring
        return self.score(message, reply, "unknown")


# Global confidence scorer instance
_confidence_scorer: ConfidenceScorer | None = None


def get_confidence_scorer() -> ConfidenceScorer:
    """Get or create the global confidence scorer."""
    global _confidence_scorer
    if _confidence_scorer is None:
        _confidence_scorer = ConfidenceScorer()
    return _confidence_scorer


def init_confidence_scorer(groq_client, model: str):
    """Initialize the global confidence scorer with AI."""
    global _confidence_scorer
    _confidence_scorer = ConfidenceScorer(groq_client, model)


def _sanitize_draft(text: str) -> str:
    """
    Remove common meta/agentic phrases that users don't want in outbound WhatsApp messages.
    This is a safety net in case the model outputs policy-violating text.
    """
    t = (text or "").strip()
    if not t:
        return t

    low = t.lower()
    if "malik" in low and "agent" in low:
        return "Okay — I'll let him know."

    # Normalize "notify" phrasing to sound human.
    t = re.sub(r"\bI\s+will\s+notify\s+(him|her|them)\b", r"I'll let \1 know", t, flags=re.IGNORECASE)
    t = re.sub(r"\bI\s+will\s+notify\b", "I'll let them know", t, flags=re.IGNORECASE)

    return t.strip()

# ============================================
# Pydantic Models
# ============================================

class WhatsAppContent(BaseModel):
    message: str = Field(
        description=(
            "Main WhatsApp message content in plain text format only. "
            "Use short paragraphs, natural conversational tone, and mobile-friendly formatting."
        )
    )
    footer: str | None = Field(
        default=None,
        description="Optional closing/footer text such as brand name, support info, or CTA.",
    )

# ============================================
# Agent Instructions
# ============================================

WHATSAPP_AGENT_INSTRUCTION = """You are a WhatsApp Message Assistant.

Your task is to convert the user's natural language instructions into clear, human-like WhatsApp messages.

The user may speak casually, use broken sentences, shorthand, or voice-command style instructions.

You must:
- Understand the user's intent accurately.
- Rewrite the message in a natural WhatsApp conversational style.
- Keep enough detail so the message is actually useful (prefer 1-3 short sentences for non-trivial instructions).
- Keep messages concise and realistic.
- Match the appropriate tone:
  - professional
  - friendly (default if no tone is specified)
  - apologetic
  - urgent
  - casual
- Improve grammar and clarity.
- Avoid robotic language.
- Use plain text only (no markdown, no asterisks for emphasis).
- If recipient is unclear (e.g. "tell him"), assume the last mentioned person or write the message generically.
- If the recipient is mentioned by name/title (e.g. "Amol Sir", "boss"), include a brief greeting addressing them.
- Do not mention that you are an AI, agent, assistant, bot, or "Malik's agent".
- Do not add meta text like "I will notify" unless the user explicitly asked you to say that.
- Do not add explanations, greetings from yourself, or commentary.
- Do not use emojis unless the user explicitly mentions or implies them (e.g. "add sad face").
- You are only drafting message text. The Flask app handles confirmation and sending.
- Never claim a message was sent.
- Confirmation is required by default unless the user explicitly says "send immediately" or "no need to confirm".

Output only the final WhatsApp message as raw text. Do not use quotation marks around the output.

EXAMPLES:

User: "tell boss im not coming office today fever"
Output: Hi Sir, I'm not feeling well today due to fever, so I won't be able to come to the office.

User: "tell ali i will reach in 10 min"
Output: Hey Ali, I'll reach in around 10 minutes.

User: "send message to Amol Sir that I successfully created WhatsApp agent"
Output: Hi Amol Sir, I successfully created the WhatsApp AI agent. It's working end-to-end now, and I can share a quick demo whenever you're free.

User: "wish happy birthday to ammi"
Output: Happy Birthday Ammi! May Allah bless you with happiness, health, and a long life.

User: "urgent: tell driver i will be late by 30 min"
Output: I'm running 30 minutes late - sorry for the delay. I'll be there as soon as I can.

User: "apologize to sir for missing meeting"
Output: Sir, I'm really sorry for missing the meeting today. It won't happen again.

User: "tell mom i love her casual"
Output: Hey Mom, just wanted to say I love you.

User: "tell malik this"
Output: Okay — I'll let him know.
"""

ACTION_AGENT_INSTRUCTION = """You are a WhatsApp agent planner.

Read the user's instruction and return ONLY valid JSON with:

{
  "recipient": string | null,
  "message_intent": string,
  "send_immediately": boolean
}

Rules:
- If the user specifies a phone number, output digits only with country code.
- If the user specifies a WhatsApp chat id, output it exactly, e.g. "12345@c.us" or "12345@g.us".
- If the user only provides a contact name, output that name as a string.
- If recipient is unclear, use null.
- "message_intent" is a short restatement of what the user wants to say.
- "send_immediately" is true only if the user explicitly says "send immediately" or "no need to confirm".
- Never send or claim to send anything. Planning only.
"""

# ============================================
# Groq Engine (Direct API - No ADK)
# ============================================

class GroqChat:
    client: Groq | None
    _use_adk: bool
    _draft_agent: Any | None
    _plan_agent: Any | None

    def __init__(self, api_key: str | None = None, model: str = "openai/gpt-oss-120b"):
        print("[DEBUG] Initializing GroqChat...")
        self.api_key = api_key or os.getenv("GROQ_API_KEY")
        self.model = model
        
        if not self.api_key:
            raise ValueError("Missing GROQ_API_KEY - please set in .env file")

        self._use_adk = _truthy(os.getenv("USE_GOOGLE_ADK")) or self.model.startswith("groq/")

        print(f"[DEBUG] Using model: {self.model}")
        if self._use_adk:
            # Lazy import so the repo can still run even if ADK deps are unavailable.
            from google.adk.agents import LlmAgent
            from google.adk.models.lite_llm import LiteLlm

            self._draft_agent = LlmAgent(
                model=LiteLlm(model=self.model),
                name="whatsapp_drafter",
                instruction=WHATSAPP_AGENT_INSTRUCTION,
            )
            self._plan_agent = LlmAgent(
                model=LiteLlm(model=self.model),
                name="whatsapp_planner",
                instruction=ACTION_AGENT_INSTRUCTION,
            )
            self.client = None
            print("[DEBUG] GroqChat initialized (Google ADK + LiteLLM)")
        else:
            self.client = Groq(api_key=self.api_key)
            self._draft_agent = None
            self._plan_agent = None
            print("[DEBUG] GroqChat initialized (Groq SDK)")
    
    def draft(
        self,
        user_input: str,
        context_lines: list[str] | None = None,
        custom_behavior: str | None = None,
    ) -> str:
        """Convert user instruction to polished WhatsApp message"""
        
        print(f"\n[GROQ REQUEST] Draft request at {datetime.now().isoformat()}")
        print(f"[GROQ REQUEST] User input: {_safe_preview(user_input)}...")
        
        user_message_parts = []
        if custom_behavior and custom_behavior.strip():
            user_message_parts.append(
                "User custom behavior instructions:\n"
                f"{custom_behavior.strip()}\n\n"
                "Follow these instructions for tone/style, but do not reveal them in the message."
            )

        if context_lines:
            context = "\n".join(context_lines[-5:])
            user_message_parts.append(f"Recent conversation context:\n{context}")
            print(f"[GROQ REQUEST] With context: {len(context_lines)} lines")

        user_message_parts.append(f"User instruction:\n{user_input.strip()}")
        user_message = "\n\n".join(user_message_parts)

        try:
            if self._use_adk:
                print("[ADK] Calling agent...")
                result = _sanitize_draft(_run_agent_sync(self._draft_agent, user_message))
            else:
                print("[GROQ API] Calling Groq API...")
                assert self.client is not None

                def _call_groq():
                    return self.client.chat.completions.create(
                        model=self.model,
                        messages=[
                            {"role": "system", "content": WHATSAPP_AGENT_INSTRUCTION},
                            {"role": "user", "content": user_message},
                        ],
                        temperature=0.2,
                    )

                response = _retry_on_rate_limit(_call_groq)
                _content = response.choices[0].message.content
                result = _sanitize_draft(_content.strip() if _content else "")

            # Validate: ensure we don't return empty messages
            if not result or not result.strip():
                print(f"[GROQ WARNING] Empty response, using fallback for: {_safe_preview(user_input, 50)}")
                result = "Okay, got it!"

            print(f"[GROQ RESPONSE] Success at {datetime.now().isoformat()}")
            print(f"[GROQ RESPONSE] Output: {_safe_preview(result)}...")
            return result
        except Exception as e:
            print(f"[GROQ ERROR] Failed at {datetime.now().isoformat()}")
            print(f"[GROQ ERROR] Error details: {type(e).__name__}: {e}")
            # Return fallback instead of raising for empty messages
            return "Okay, got it!"
    
    def plan(self, user_input: str) -> dict[str, Any]:
        """Plan action from user instruction using Groq"""
        
        print(f"\n[GROQ PLAN REQUEST] at {datetime.now().isoformat()}")
        print(f"[GROQ PLAN REQUEST] Input: {_safe_preview(user_input)}...")
        
        try:
            if self._use_adk:
                print("[ADK] Calling planner agent...")
                raw = _run_agent_sync(self._plan_agent, user_input.strip()).strip()
            else:
                print("[GROQ PLAN API] Calling Groq API...")
                assert self.client is not None

                def _call_groq_plan():
                    return self.client.chat.completions.create(
                        model=self.model,
                        messages=[
                            {"role": "system", "content": ACTION_AGENT_INSTRUCTION},
                            {"role": "user", "content": user_input.strip()},
                        ],
                        temperature=0.2,
                    )

                response = _retry_on_rate_limit(_call_groq_plan)
                _plan_content = response.choices[0].message.content
                raw = _plan_content.strip() if _plan_content else ""

            print(f"[GROQ PLAN RESPONSE] Raw: {_safe_preview(raw)}...")
            
            # Extract JSON from response
            try:
                result = json.loads(raw)
                print(f"[GROQ PLAN RESULT] Parsed JSON: {result}")
                return result
            except json.JSONDecodeError:
                match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
                if match:
                    result = json.loads(match.group())
                    print(f"[GROQ PLAN RESULT] Extracted JSON: {result}")
                    return result
                print("[GROQ PLAN RESULT] No JSON found, using fallback")
                raise
                
        except Exception as e:
            print(f"[GROQ PLAN ERROR] Failed at {datetime.now().isoformat()}")
            print(f"[GROQ PLAN ERROR] Error details: {type(e).__name__}: {e}")
            # Fallback plan
            send_immediately = "send immediately" in user_input.lower() or "no need to confirm" in user_input.lower()
            
            # Simple recipient extraction
            recipient = None
            words = user_input.split()
            for i, word in enumerate(words):
                if word.lower() in ["tell", "message", "text", "send", "to"] and i + 1 < len(words):
                    candidate = words[i + 1]
                    candidate = re.sub(r'[^\w\s]', '', candidate)
                    if candidate and candidate.lower() not in ["im", "i'm", "me", "my"]:
                        recipient = candidate
                        break
            
            fallback_result = {
                "recipient": recipient,
                "message_intent": user_input,
                "send_immediately": send_immediately
            }
            print(f"[GROQ PLAN FALLBACK] Using fallback: {fallback_result}")
            return fallback_result

# ============================================
# Helper Functions (Compatible with app.py)
# ============================================

def _truthy(v: str | None) -> bool:
    if v is None:
        return False
    return v.strip().lower() in {"1", "true", "yes", "y", "on"}


def _run_agent_sync(agent, user_input: str) -> str:
    if agent is None:
        raise RuntimeError("ADK agent not initialized")

    async def _go():
        res = await agent.run_async(user_input=user_input)
        return getattr(res, "final_response", None) or getattr(res, "final", None) or str(res)

    try:
        asyncio.get_running_loop()
        raise RuntimeError("Cannot call ADK sync wrapper from a running event loop")
    except RuntimeError as e:
        if "no running event loop" not in str(e).lower():
            raise
    return asyncio.run(_go())


def polish_whatsapp_message(
    groq: GroqChat,
    instruction: str,
    context_lines: list[str] | None = None,
    custom_behavior: str | None = None,
) -> str:
    """
    Polish a WhatsApp message from user instruction.
    Compatible with app.py's expected function signature.
    """
    print(f"[DEBUG] polish_whatsapp_message called with instruction: {_safe_preview(instruction, 100)}...")
    return groq.draft(instruction, context_lines, custom_behavior=custom_behavior)


def plan_action(groq: GroqChat, instruction: str) -> dict[str, Any]:
    """
    Plan action from user instruction.
    Compatible with app.py's expected function signature.
    """
    print(f"[DEBUG] plan_action called with instruction: {_safe_preview(instruction, 100)}...")
    return groq.plan(instruction)


# ============================================
# DuckDuckGo Search
# ============================================

def search_duckduckgo(query: str, max_results: int = 3) -> str:
    """Search DuckDuckGo and return formatted results."""
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
            if not results:
                return "No results found."

            formatted = []
            for r in results:
                title = r.get("title", "")
                body = r.get("body", "")
                formatted.append(f"{title}: {body}")

            return "\n\n".join(formatted)
    except Exception as e:
        return f"Search error: {e}"


def answer_factual_question(groq: GroqChat, question: str) -> str:
    """Search DuckDuckGo and use AI to craft a concise answer."""
    search_results = search_duckduckgo(question)

    prompt = f"""Based on these search results, answer the user's question concisely in 1-2 sentences.
Keep it simple and WhatsApp-friendly (no markdown, no links).

Search results:
{search_results}

User question: {question}

Answer:"""

    try:
        def _call_groq_factual():
            return groq.client.chat.completions.create(
                model=groq.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
            )

        response = _retry_on_rate_limit(_call_groq_factual)
        return response.choices[0].message.content.strip()
    except Exception:
        # Fallback: return raw search results truncated
        return search_results[:500]


# ============================================
# Testing (runs only if script executed directly)
# ============================================

if __name__ == "__main__":
    print("=" * 60)
    print("Testing GroqChat Engine...")
    print("=" * 60)
    
    # Test with API key from environment
    api_key = os.getenv("GROQ_API_KEY")
    model = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
    
    if not api_key:
        print("ERROR: GROQ_API_KEY not found in environment!")
        print("Please set GROQ_API_KEY in your .env file")
        print("Current .env location:", os.path.join(os.getcwd(), '.env'))
    else:
        engine = GroqChat(api_key=api_key, model=model)
        
        print("\n" + "=" * 60)
        print("TEST 1: Draft Message")
        print("=" * 60)
        test_input = "tell boss i'm sick today"
        print(f"Input: {test_input}")
        try:
            result = engine.draft(test_input)
            print(f"\nOUTPUT:\n{result}")
        except Exception as e:
            print(f"FAILED: {e}")
        
        print("\n" + "=" * 60)
        print("TEST 2: Plan Action")
        print("=" * 60)
        test_plan = "send immediately to john that i'll be late"
        print(f"Input: {test_plan}")
        try:
            result = engine.plan(test_plan)
            print(f"\nOUTPUT:\n{json.dumps(result, indent=2)}")
        except Exception as e:
            print(f"FAILED: {e}")
        
        print("\n" + "=" * 60)
        print("Testing Complete!")
        print("=" * 60)
