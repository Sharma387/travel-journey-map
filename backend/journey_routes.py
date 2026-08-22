"""Journey CRUD routes — owner-scoped (family sharing arrives in Phase 2)."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth_routes import auto_color_hue
from db import get_db
from models import Family, Journey, Stop, User
from schemas import JourneyCreate, JourneyOut
from security import get_current_user

router = APIRouter(prefix="/api", tags=["journeys"])


def _store_json(value):
    """Serialize a dict/list (polygons, candidates) to JSON text, or None."""
    if value is None:
        return None
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return None


def stop_to_dict(stop: Stop) -> dict:
    """Serialise a Stop row back to the frontend stop shape."""

    def _loads(value):
        if not value:
            return None
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return None

    return {
        "order": stop.order,
        "location": stop.location,
        "exact_location": stop.exact_location,
        "start_date": stop.start_date,
        "end_date": stop.end_date,
        "category": stop.category,
        "notes": stop.notes,
        "lat": stop.lat,
        "lng": stop.lng,
        "geojson": _loads(stop.geojson),
        "state_name": stop.state_name,
        "state_geojson": _loads(stop.state_geojson),
        "country_name": stop.country_name,
        "country_geojson": _loads(stop.country_geojson),
        "is_ambiguous": stop.is_ambiguous,
        "warning": stop.warning,
        "candidates": _loads(stop.candidates) or [],
        "note": stop.note,
        "geocode_error": stop.geocode_error,
    }


def journey_out(journey: Journey, owner_name: str, stops: list[Stop]) -> dict:
    return {
        "id": journey.id,
        "owner_id": journey.owner_id,
        "title": journey.title,
        "source_type": journey.source_type,
        "llm_used": journey.llm_used,
        "llm_model": journey.llm_model,
        "engine": journey.engine,
        "created_at": journey.created_at.isoformat() if journey.created_at else None,
        "owner_name": owner_name,
        "stops": [stop_to_dict(s) for s in stops],
    }


def journey_summary(journey: Journey, stops: list[Stop]) -> dict:
    dates = sorted(
        s.start_date or s.end_date for s in stops if (s.start_date or s.end_date)
    )
    return {
        "id": journey.id,
        "title": journey.title,
        "stop_count": len(stops),
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
        "created_at": journey.created_at.isoformat() if journey.created_at else None,
    }


def _journey_stops(db: Session, journey_id: int) -> list[Stop]:
    return list(
        db.scalars(
            select(Stop).where(Stop.journey_id == journey_id).order_by(Stop.order)
        ).all()
    )


def _get_owned_journey(db: Session, journey_id: int, user: User) -> Journey:
    journey = db.get(Journey, journey_id)
    if journey is None:
        raise HTTPException(status_code=404, detail="Journey not found.")
    if journey.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Not your journey.")
    return journey


def _apply_stops(db: Session, journey_id: int, stops: list) -> None:
    for s in stops:
        db.add(
            Stop(
                journey_id=journey_id,
                order=s.order or 0,
                location=(s.location or "")[:300],
                exact_location=(s.exact_location or "")[:500],
                start_date=s.start_date,
                end_date=s.end_date,
                category=s.category,
                notes=s.notes,
                lat=s.lat,
                lng=s.lng,
                geojson=_store_json(s.geojson),
                state_name=s.state_name,
                state_geojson=_store_json(s.state_geojson),
                country_name=s.country_name,
                country_geojson=_store_json(s.country_geojson),
                is_ambiguous=s.is_ambiguous,
                warning=s.warning,
                candidates=_store_json(s.candidates),
                note=s.note,
                geocode_error=s.geocode_error,
            )
        )


@router.post("/journeys", response_model=JourneyOut)
def create_journey(
    body: JourneyCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    journey = Journey(
        owner_id=user.id,
        title=(body.title or "Untitled journey")[:200],
        source_type=body.source_type,
        llm_used=body.llm_used,
        llm_model=body.llm_model,
        engine=body.engine,
    )
    db.add(journey)
    db.flush()
    _apply_stops(db, journey.id, body.stops)
    db.commit()
    db.refresh(journey)
    return journey_out(journey, user.display_name, _journey_stops(db, journey.id))


@router.get("/journeys")
def list_journeys(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    journeys = db.scalars(
        select(Journey)
        .where(Journey.owner_id == user.id)
        .order_by(Journey.created_at.desc())
    ).all()
    return [journey_summary(j, _journey_stops(db, j.id)) for j in journeys]


@router.get("/journeys/family")
def family_journeys(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """All family members' journeys with their per-user colour (family map)."""
    if user.family_id is None:
        raise HTTPException(status_code=404, detail="You are not part of a family yet.")
    family = db.get(Family, user.family_id)
    if family is None:
        raise HTTPException(status_code=404, detail="Family not found.")
    members = db.scalars(
        select(User).where(User.family_id == family.id).order_by(User.display_name)
    ).all()
    out_members = []
    for member in members:
        journeys = db.scalars(
            select(Journey)
            .where(Journey.owner_id == member.id)
            .order_by(Journey.created_at.desc())
        ).all()
        out_members.append(
            {
                "id": member.id,
                "username": member.username,
                "display_name": member.display_name,
                "color_hue": member.color_hue
                or auto_color_hue(member.username),
                "journeys": [
                    journey_out(j, member.display_name, _journey_stops(db, j.id))
                    for j in journeys
                ],
            }
        )
    return {
        "family": {"id": family.id, "name": family.name},
        "members": out_members,
    }


@router.get("/journeys/{journey_id}", response_model=JourneyOut)
def get_journey(
    journey_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    journey = db.get(Journey, journey_id)
    if journey is None:
        raise HTTPException(status_code=404, detail="Journey not found.")
    if journey.owner_id != user.id and (
        not user.family_id
        or journey.owner_id
        not in [u.id for u in db.scalars(select(User).where(User.family_id == user.family_id))]
    ):
        raise HTTPException(status_code=403, detail="Not your journey.")
    owner = db.get(User, journey.owner_id)
    return journey_out(journey, owner.display_name if owner else "", _journey_stops(db, journey.id))


@router.put("/journeys/{journey_id}", response_model=JourneyOut)
def update_journey(
    journey_id: int,
    body: JourneyCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    journey = _get_owned_journey(db, journey_id, user)
    journey.title = (body.title or journey.title or "Untitled journey")[:200]
    journey.source_type = body.source_type
    journey.llm_used = body.llm_used
    journey.llm_model = body.llm_model
    journey.engine = body.engine
    # Replace the stops wholesale (simplest correct approach for v1).
    for old in _journey_stops(db, journey.id):
        db.delete(old)
    db.flush()
    _apply_stops(db, journey.id, body.stops)
    db.commit()
    db.refresh(journey)
    return journey_out(journey, user.display_name, _journey_stops(db, journey.id))


@router.delete("/journeys/{journey_id}", status_code=204)
def delete_journey(
    journey_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    journey = _get_owned_journey(db, journey_id, user)
    db.delete(journey)
    db.commit()
