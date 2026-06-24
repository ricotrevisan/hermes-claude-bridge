"""Hermes model-provider plugin: Claude via the local Claude Code bridge.

Declarative ProviderProfile only — it points Hermes at the local bridge server
(an OpenAI-compatible endpoint backed by the Claude Agent SDK on your Claude
Code subscription). Hermes reaches it over plain chat_completions HTTP; nothing
is spawned by Hermes.

The bridge ignores authentication: requests to a localhost base_url with no key
get a "no-key-required" placeholder from Hermes, exactly like a local Ollama /
llama.cpp endpoint. CLAUDE_BRIDGE_API_KEY is declared only so Hermes registers
this provider for `hermes model` selection — leave it unset; the bridge never
reads it.

Port resolution: defaults to 8787, overridable via CLAUDE_BRIDGE_PORT. The
installer bakes the chosen port into base_url for service installs; for the
dev symlink workflow, export CLAUDE_BRIDGE_PORT in the same shell as both the
bridge and `hermes`.
"""

import os

from providers import register_provider
from providers.base import ProviderProfile

_PORT = os.environ.get("CLAUDE_BRIDGE_PORT", "8787")

register_provider(
    ProviderProfile(
        name="claude-bridge",
        aliases=("claude-code", "cc-bridge"),
        display_name="Claude Bridge (Claude Code subscription)",
        description="Claude via local Claude Code bridge — no API key",
        api_mode="chat_completions",
        base_url=f"http://127.0.0.1:{_PORT}/v1",
        auth_type="api_key",
        env_vars=("CLAUDE_BRIDGE_API_KEY",),  # optional/ignored; enables registration only
        supports_health_check=True,  # bridge implements GET /v1/models
        supports_vision=True,  # Claude is multimodal; the bridge passes images through
        fallback_models=(
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
        ),
    )
)
