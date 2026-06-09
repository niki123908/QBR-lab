from __future__ import annotations

_env_loaded = False


def ensure_qbr_env() -> None:
    """Load QBR/.env once before reading DATABASE_URL or starting services."""
    global _env_loaded
    if _env_loaded:
        return
    from dotenv import load_dotenv

    from app.core.paths import qbr_root

    root = qbr_root()
    env_file = root / ".env"
    if env_file.is_file():
        load_dotenv(env_file, override=False)
    _env_loaded = True


def default_database_url() -> str:
    return "postgresql://qbr:qbr@127.0.0.1:5433/qbr"
