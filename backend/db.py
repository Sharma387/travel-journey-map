"""Database setup (SQLAlchemy).

Uses SQLite by default (zero-config, local-first). Set ``DATABASE_URL`` to a
Postgres URL when the app is hosted in the cloud — the models are written
portably so it's a config change, not a rewrite.
"""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DB_PATH = Path(__file__).resolve().parent / "app.db"
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DB_PATH}")

_is_sqlite = DATABASE_URL.startswith("sqlite")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency that yields a scoped DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create all tables + run light migrations. Idempotent."""
    import models  # ensure models are registered on Base.metadata

    Base.metadata.create_all(bind=engine)
    _migrate()


def _migrate() -> None:
    """Additive column migrations for existing SQLite databases."""
    with engine.connect() as conn:
        cols = {
            row[1]
            for row in conn.execute(
                text("SELECT * FROM pragma_table_info('users')")
            )
        }
        if "color_hue" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN color_hue INTEGER"))
        # journeys table: share_token
        jcols = {
            row[1]
            for row in conn.execute(
                text("SELECT * FROM pragma_table_info('journeys')")
            )
        }
        if "share_token" not in jcols:
            conn.execute(text("ALTER TABLE journeys ADD COLUMN share_token VARCHAR(64)"))
        conn.commit()
