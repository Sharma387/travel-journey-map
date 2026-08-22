"""Pydantic schemas for auth + admin + journeys."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=128)


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str
    role: str
    family_id: int | None = None
    created_at: str | None = None

    @classmethod
    def from_user(cls, user) -> "UserOut":
        return cls(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            role=user.role,
            family_id=user.family_id,
            created_at=user.created_at.isoformat() if user.created_at else None,
        )


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ---------------------------------------------------------------------------
# Admin: users & families
# ---------------------------------------------------------------------------
class FamilyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class FamilyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)


class FamilyOut(BaseModel):
    id: int
    name: str
    created_by: int
    created_at: str | None = None
    members: list[UserOut] = []

    @classmethod
    def from_family(cls, family, include_members: bool = False) -> "FamilyOut":
        return cls(
            id=family.id,
            name=family.name,
            created_by=family.created_by,
            created_at=family.created_at.isoformat() if family.created_at else None,
            members=(
                [UserOut.from_user(u) for u in family.members] if include_members else []
            ),
        )


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=80)
    password: str = Field(min_length=6, max_length=128)
    display_name: str = Field(min_length=1, max_length=120)
    role: str = Field(default="member", pattern="^(admin|member)$")
    family_id: int | None = None


class UserUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    role: str | None = Field(default=None, pattern="^(admin|member)$")
    password: str | None = Field(default=None, min_length=6, max_length=128)
    family_id: int | None = None
    clear_family: bool = False


# ---------------------------------------------------------------------------
# Journeys
# ---------------------------------------------------------------------------
class StopIn(BaseModel):
    order: int | None = None
    location: str = ""
    exact_location: str = ""
    start_date: str | None = None
    end_date: str | None = None
    category: str | None = None
    notes: str | None = None
    lat: float | None = None
    lng: float | None = None
    geojson: Any | None = None
    state_name: str | None = None
    state_geojson: Any | None = None
    country_name: str | None = None
    country_geojson: Any | None = None
    is_ambiguous: bool = False
    warning: str | None = None
    candidates: list[str] | None = None
    note: str | None = None
    geocode_error: str | None = None


class JourneyCreate(BaseModel):
    title: str = Field(default="Untitled journey", max_length=200)
    source_type: str | None = None
    llm_used: bool = False
    llm_model: str | None = None
    engine: str | None = None
    stops: list[StopIn] = []


class JourneyOut(BaseModel):
    id: int
    owner_id: int
    title: str
    source_type: str | None = None
    llm_used: bool = False
    llm_model: str | None = None
    engine: str | None = None
    created_at: str | None = None
    owner_name: str | None = None
    stops: list[dict[str, Any]] = []
