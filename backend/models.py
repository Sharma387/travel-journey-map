"""SQLAlchemy models: families, users, journeys, stops."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db import Base


def utcnow() -> datetime:
    """Naive UTC now (SQLite-friendly, no deprecation warnings)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Family(Base):
    __tablename__ = "families"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    members: Mapped[list[User]] = relationship(
        back_populates="family", foreign_keys="User.family_id"
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(
        String(80), unique=True, index=True, nullable=False
    )
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), default="member", nullable=False)
    family_id: Mapped[int | None] = mapped_column(
        ForeignKey("families.id"), nullable=True
    )
    color_hue: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    family: Mapped[Family | None] = relationship(
        back_populates="members", foreign_keys="User.family_id"
    )
    journeys: Mapped[list[Journey]] = relationship(
        back_populates="owner", cascade="all, delete-orphan"
    )


class Journey(Base):
    __tablename__ = "journeys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), default="Untitled journey")
    source_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    llm_used: Mapped[bool] = mapped_column(Boolean, default=False)
    llm_model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    engine: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    owner: Mapped[User] = relationship(back_populates="journeys")
    stops: Mapped[list[Stop]] = relationship(
        back_populates="journey", cascade="all, delete-orphan", order_by="Stop.order"
    )


class Stop(Base):
    __tablename__ = "stops"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    journey_id: Mapped[int] = mapped_column(ForeignKey("journeys.id"), nullable=False)
    order: Mapped[int] = mapped_column(Integer, default=0)
    location: Mapped[str] = mapped_column(String(300), default="")
    exact_location: Mapped[str] = mapped_column(String(500), default="")
    start_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    end_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    category: Mapped[str | None] = mapped_column(String(20), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    geojson: Mapped[str | None] = mapped_column(Text, nullable=True)
    state_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    state_geojson: Mapped[str | None] = mapped_column(Text, nullable=True)
    country_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    country_geojson: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_ambiguous: Mapped[bool] = mapped_column(Boolean, default=False)
    warning: Mapped[str | None] = mapped_column(Text, nullable=True)
    candidates: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    geocode_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    journey: Mapped[Journey] = relationship(back_populates="stops")
