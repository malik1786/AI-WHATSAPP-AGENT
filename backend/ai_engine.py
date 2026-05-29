from __future__ import annotations
import os
import json
import re
import sys
import asyncio
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
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": WHATSAPP_AGENT_INSTRUCTION},
                        {"role": "user", "content": user_message},
                    ],
                    temperature=0.2,
                )
                _content = response.choices[0].message.content
                result = _sanitize_draft(_content.strip() if _content else "")

            print(f"[GROQ RESPONSE] Success at {datetime.now().isoformat()}")
            print(f"[GROQ RESPONSE] Output: {_safe_preview(result)}...")
            return result
        except Exception as e:
            print(f"[GROQ ERROR] Failed at {datetime.now().isoformat()}")
            print(f"[GROQ ERROR] Error details: {type(e).__name__}: {e}")
            raise
    
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
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": ACTION_AGENT_INSTRUCTION},
                        {"role": "user", "content": user_input.strip()},
                    ],
                    temperature=0.2,
                )
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
        response = groq.client.chat.completions.create(
            model=groq.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
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
