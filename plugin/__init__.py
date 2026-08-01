"""Hermes model-provider plugin: Claude via the local Claude Code bridge.

Declarative ProviderProfile only — it points Hermes at the local bridge server
(an OpenAI-compatible endpoint backed by the Claude Agent SDK on your Claude
subscription). Hermes reaches it over plain chat_completions HTTP; the bridge
owns the SDK subprocess lifecycle.

CLAUDE_BRIDGE_API_KEY is a real credential: the installer generates a random
per-install token, and the bridge rejects any request whose Authorization
bearer token does not match it.

Port resolution: defaults to 8787, overridable via CLAUDE_BRIDGE_PORT. The
installer bakes the chosen port into base_url for service installs; for the
dev symlink workflow, export CLAUDE_BRIDGE_PORT in the same shell as both the
bridge and `hermes`.
"""

import os

from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

_PORT = os.environ.get("CLAUDE_BRIDGE_PORT", "8787")


class ClaudeBridgeProfile(ProviderProfile):
    """Forward Hermes reasoning effort using the bridge's OpenAI-compatible field."""

    def build_api_kwargs_extras(
        self,
        *,
        reasoning_config: dict | None = None,
        **context: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        if not reasoning_config or reasoning_config.get("enabled") is False:
            return {}, {}
        effort = str(reasoning_config.get("effort", "medium")).lower()
        effort = {
            "none": None,
            "off": None,
            "minimal": "low",
            "ultra": "max",
        }.get(effort, effort)
        if effort not in {"low", "medium", "high", "xhigh", "max"}:
            return {}, {}
        return {}, {"reasoning_effort": effort}


register_provider(
    ClaudeBridgeProfile(
        name="claude-bridge",
        aliases=("claude-code", "cc-bridge"),
        display_name="Claude Bridge (Claude Code subscription)",
        description="Claude via local Claude Code bridge — no API key",
        api_mode="chat_completions",
        base_url=f"http://127.0.0.1:{_PORT}/v1",
        auth_type="api_key",
        env_vars=("CLAUDE_BRIDGE_API_KEY",),  # per-install bearer token, validated by the bridge
        supports_health_check=True,  # bridge implements GET /v1/models
        supports_vision=True,  # Claude is multimodal; the bridge passes images through
        fallback_models=(
            "claude-fable-5",
            "claude-opus-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
        ),
    )
)
