"""Auth (login/me) + admin (users/families) routes."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from db import get_db
from models import Family, User
from schemas import (
    FamilyCreate,
    FamilyOut,
    FamilyUpdate,
    LoginRequest,
    TokenResponse,
    UserCreate,
    UserOut,
    UserUpdate,
)
from security import create_token, get_current_user, hash_password, require_admin, verify_password

router = APIRouter(prefix="/api", tags=["auth"])


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
@router.post("/auth/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == body.username))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    return TokenResponse(access_token=create_token(user), user=UserOut.from_user(user))


@router.get("/auth/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut.from_user(user)


# ---------------------------------------------------------------------------
# Admin — users
# ---------------------------------------------------------------------------
@router.post("/admin/users", response_model=UserOut)
def admin_create_user(body: UserCreate, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    if db.scalar(select(User).where(User.username == body.username)):
        raise HTTPException(status_code=409, detail="Username already exists.")
    if body.family_id is not None and db.get(Family, body.family_id) is None:
        raise HTTPException(status_code=404, detail="Family not found.")
    user = User(
        username=body.username,
        display_name=body.display_name,
        password_hash=hash_password(body.password),
        role=body.role,
        family_id=body.family_id,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return UserOut.from_user(user)


@router.get("/admin/users", response_model=list[UserOut])
def admin_list_users(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    users = db.scalars(select(User).order_by(User.display_name)).all()
    return [UserOut.from_user(u) for u in users]


@router.patch("/admin/users/{user_id}", response_model=UserOut)
def admin_update_user(
    user_id: int,
    body: UserUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    if body.display_name is not None:
        user.display_name = body.display_name
    if body.role is not None:
        user.role = body.role
    if body.password is not None:
        user.password_hash = hash_password(body.password)
    if body.clear_family:
        user.family_id = None
    elif body.family_id is not None:
        if db.get(Family, body.family_id) is None:
            raise HTTPException(status_code=404, detail="Family not found.")
        user.family_id = body.family_id
    db.commit()
    db.refresh(user)
    return UserOut.from_user(user)


@router.delete("/admin/users/{user_id}", status_code=204)
def admin_delete_user(
    user_id: int, db: Session = Depends(get_db), admin: User = Depends(require_admin)
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself.")
    db.delete(user)
    db.commit()


# ---------------------------------------------------------------------------
# Admin — families
# ---------------------------------------------------------------------------
@router.post("/admin/families", response_model=FamilyOut)
def admin_create_family(
    body: FamilyCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)
):
    family = Family(name=body.name, created_by=admin.id)
    db.add(family)
    db.commit()
    db.refresh(family)
    return FamilyOut.from_family(family, include_members=True)


@router.get("/admin/families", response_model=list[FamilyOut])
def admin_list_families(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    families = db.scalars(select(Family).order_by(Family.name)).all()
    return [FamilyOut.from_family(f, include_members=True) for f in families]


@router.patch("/admin/families/{family_id}", response_model=FamilyOut)
def admin_update_family(
    family_id: int,
    body: FamilyUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    family = db.get(Family, family_id)
    if family is None:
        raise HTTPException(status_code=404, detail="Family not found.")
    if body.name is not None:
        family.name = body.name
    db.commit()
    db.refresh(family)
    return FamilyOut.from_family(family, include_members=True)


@router.delete("/admin/families/{family_id}", status_code=204)
def admin_delete_family(
    family_id: int, db: Session = Depends(get_db), _: User = Depends(require_admin)
):
    family = db.get(Family, family_id)
    if family is None:
        raise HTTPException(status_code=404, detail="Family not found.")
    # Detach members before deleting the family.
    for member in family.members:
        member.family_id = None
    db.delete(family)
    db.commit()
