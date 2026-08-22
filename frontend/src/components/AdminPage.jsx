import { useEffect, useState } from "react";
import {
  adminCreateFamily,
  adminCreateUser,
  adminDeleteFamily,
  adminDeleteUser,
  adminFamilies,
  adminUpdateUser,
  adminUsers,
} from "../api";

const EMPTY_USER_FORM = {
  username: "",
  display_name: "",
  password: "",
  role: "member",
  family_id: "",
};

export default function AdminPage({ token }) {
  const [users, setUsers] = useState([]);
  const [families, setFamilies] = useState([]);
  const [userForm, setUserForm] = useState(EMPTY_USER_FORM);
  const [familyName, setFamilyName] = useState("");
  const [msg, setMsg] = useState(null); // {kind: "ok"|"err", text}
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [u, f] = await Promise.all([adminUsers(token), adminFamilies(token)]);
      setUsers(u || []);
      setFamilies(f || []);
    } catch (err) {
      setMsg({ kind: "err", text: err.message || String(err) });
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const flash = (kind, text) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const createUser = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const body = {
        username: userForm.username.trim(),
        display_name: userForm.display_name.trim(),
        password: userForm.password,
        role: userForm.role,
        family_id: userForm.family_id ? Number(userForm.family_id) : null,
      };
      await adminCreateUser(body, token);
      setUserForm(EMPTY_USER_FORM);
      flash("ok", `Created user "${body.display_name}".`);
      await load();
    } catch (err) {
      flash("err", err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const updateUserFamily = async (id, familyId) => {
    try {
      await adminUpdateUser(
        id,
        { family_id: familyId ? Number(familyId) : null, clear_family: !familyId },
        token,
      );
      await load();
    } catch (err) {
      flash("err", err.message || String(err));
    }
  };

  const removeUser = async (id) => {
    try {
      await adminDeleteUser(id, token);
      await load();
    } catch (err) {
      flash("err", err.message || String(err));
    }
  };

  const createFamily = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await adminCreateFamily(familyName.trim(), token);
      setFamilyName("");
      flash("ok", "Family created.");
      await load();
    } catch (err) {
      flash("err", err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeFamily = async (id) => {
    try {
      await adminDeleteFamily(id, token);
      await load();
    } catch (err) {
      flash("err", err.message || String(err));
    }
  };

  const inputCls =
    "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:border-blue-500 focus:outline-none";
  const labelCls =
    "mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400";

  return (
    <div className="mx-auto w-full max-w-3xl p-4 lg:p-6">
      <h1 className="text-lg font-bold tracking-tight text-slate-800">
        👤 Admin
      </h1>
      <p className="text-xs text-slate-400">
        Create profiles and organise family groups. Members log in with their
        username &amp; password.
      </p>

      {msg && (
        <p
          className={`mt-3 rounded-md px-3 py-2 text-xs font-medium ${
            msg.kind === "ok"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-red-50 text-red-700"
          }`}
        >
          {msg.text}
        </p>
      )}

      {/* Users */}
      <section className="mt-5">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Profiles</h2>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <form onSubmit={createUser} className="grid grid-cols-2 gap-2.5">
            <div>
              <label className={labelCls}>Username</label>
              <input
                value={userForm.username}
                onChange={(e) =>
                  setUserForm({ ...userForm, username: e.target.value })
                }
                className={inputCls}
                placeholder="vaish"
                required
              />
            </div>
            <div>
              <label className={labelCls}>Display name</label>
              <input
                value={userForm.display_name}
                onChange={(e) =>
                  setUserForm({ ...userForm, display_name: e.target.value })
                }
                className={inputCls}
                placeholder="Vaish"
                required
              />
            </div>
            <div>
              <label className={labelCls}>Password</label>
              <input
                type="password"
                value={userForm.password}
                onChange={(e) =>
                  setUserForm({ ...userForm, password: e.target.value })
                }
                className={inputCls}
                placeholder="min 6 chars"
                required
              />
            </div>
            <div>
              <label className={labelCls}>Role</label>
              <select
                value={userForm.role}
                onChange={(e) =>
                  setUserForm({ ...userForm, role: e.target.value })
                }
                className={inputCls}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Family</label>
              <select
                value={userForm.family_id}
                onChange={(e) =>
                  setUserForm({ ...userForm, family_id: e.target.value })
                }
                className={inputCls}
              >
                <option value="">— No family —</option>
                {families.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-blue-600 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              >
                + Create profile
              </button>
            </div>
          </form>

          {/* Users list */}
          <ul className="mt-4 divide-y divide-slate-100">
            {users.map((u) => (
              <li
                key={u.id}
                className="flex flex-wrap items-center gap-2 py-2 text-xs"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-semibold text-slate-700">
                    {u.display_name}
                  </span>
                  <span className="text-slate-400"> @{u.username}</span>
                  <span
                    className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      u.role === "admin"
                        ? "bg-purple-100 text-purple-700"
                        : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {u.role}
                  </span>
                </span>
                <select
                  value={u.family_id ?? ""}
                  onChange={(e) => updateUserFamily(u.id, e.target.value)}
                  className="rounded border border-slate-200 px-1.5 py-1 text-xs"
                  title="Assign family"
                >
                  <option value="">No family</option>
                  {families.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => removeUser(u.id)}
                  disabled={u.username === "admin"}
                  className="rounded border border-slate-200 px-1.5 py-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                  title={u.username === "admin" ? "Cannot delete admin" : "Delete user"}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Families */}
      <section className="mt-5">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Families</h2>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <form onSubmit={createFamily} className="flex gap-2">
            <input
              value={familyName}
              onChange={(e) => setFamilyName(e.target.value)}
              className={`${inputCls} flex-1`}
              placeholder="e.g. Sharma Family"
              required
            />
            <button
              type="submit"
              disabled={busy}
              className="shrink-0 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-40"
            >
              + Add family
            </button>
          </form>
          <ul className="mt-3 space-y-2">
            {families.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs"
              >
                <div>
                  <span className="font-semibold text-slate-700">{f.name}</span>
                  <span className="text-slate-400">
                    {" "}
                    · {f.members?.length ?? 0} member
                    {(f.members?.length ?? 0) === 1 ? "" : "s"}
                  </span>
                  {f.members?.length > 0 && (
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      {f.members.map((m) => m.display_name).join(", ")}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => removeFamily(f.id)}
                  disabled={f.members?.length > 0}
                  className="rounded border border-slate-200 px-1.5 py-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                  title={
                    f.members?.length > 0
                      ? "Move members out first"
                      : "Delete family"
                  }
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
