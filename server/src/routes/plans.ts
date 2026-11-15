import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { getAdapter } from "../sync/engine.js";

export function registerPlanRoutes(app: FastifyInstance) {
  app.get("/api/plans", async () =>
    db.prepare(`SELECT * FROM plans ORDER BY created_at DESC`).all()
  );

  app.get("/api/plans/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = db.prepare(`SELECT * FROM plans WHERE id = ?`).get(Number(id));
    if (!plan) return reply.code(404).send({ error: "计划不存在" });
    const workouts = db.prepare(
      `SELECT * FROM plan_workouts WHERE plan_id = ? ORDER BY date`
    ).all(Number(id));
    return { plan, workouts };
  });

  app.post("/api/plans", async (req) => {
    const { goal, startDate, weeks, workouts } = req.body as any;
    const info = db.prepare(
      `INSERT INTO plans (goal, start_date, weeks) VALUES (?, ?, ?)`
    ).run(goal || "训练计划", startDate || new Date().toISOString().slice(0, 10), weeks || 1);
    const planId = info.lastInsertRowid as number;
    const ins = db.prepare(
      `INSERT INTO plan_workouts (plan_id, date, sport, title, steps) VALUES (?, ?, ?, ?, ?)`
    );
    for (const w of workouts || []) {
      ins.run(planId, w.date, w.sport || "other", w.title || "训练", JSON.stringify(w.steps || []));
    }
    return { planId };
  });

  // 编辑单课（确认前可改）
  app.put("/api/plan-workouts/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { date, sport, title, steps, pushTarget } = req.body as any;
    db.prepare(
      `UPDATE plan_workouts SET date = COALESCE(?, date), sport = COALESCE(?, sport),
       title = COALESCE(?, title), steps = COALESCE(?, steps), push_target = COALESCE(?, push_target)
       WHERE id = ?`
    ).run(date ?? null, sport ?? null, title ?? null, steps ? JSON.stringify(steps) : null, pushTarget ?? null, Number(id));
    return { ok: true };
  });

  app.delete("/api/plan-workouts/:id", async (req) => {
    const { id } = req.params as { id: string };
    db.prepare(`DELETE FROM plan_workouts WHERE id = ?`).run(Number(id));
    return { ok: true };
  });

  app.post("/api/plans/:id/activate", async (req) => {
    const { id } = req.params as { id: string };
    db.prepare(`UPDATE plans SET status = 'active' WHERE id = ?`).run(Number(id));
    return { ok: true };
  });

  // 推送到目标 App（用户确认后触发）
  app.post("/api/plan-workouts/:id/push", async (req, reply) => {
    const { id } = req.params as { id: string };
    const w = db.prepare(`SELECT * FROM plan_workouts WHERE id = ?`).get(Number(id)) as any;
    if (!w) return reply.code(404).send({ error: "课程不存在" });
    const target = w.push_target || "garmin";
    const adapter = getAdapter(target === "mock" ? "mock_garmin" : target);
    if (!adapter?.pushWorkout) {
      db.prepare(`UPDATE plan_workouts SET push_status = 'failed', push_error = ? WHERE id = ?`)
        .run(`${target} 适配器不支持推送`, w.id);
      return reply.code(400).send({ error: `${target} 不支持推送` });
    }
    const avail = adapter.available();
    if (!avail.ok) {
      db.prepare(`UPDATE plan_workouts SET push_status = 'failed', push_error = ? WHERE id = ?`).run(avail.reason, w.id);
      return reply.code(400).send({ error: avail.reason });
    }
    try {
      const steps = JSON.parse(w.steps);
      const res = await adapter.pushWorkout(null, { title: w.title, sport: w.sport, date: w.date, steps }, w.date);
      db.prepare(`UPDATE plan_workouts SET push_status = 'pushed', push_error = NULL, external_id = ? WHERE id = ?`)
        .run(res.externalId, w.id);
      return { ok: true, externalId: res.externalId };
    } catch (e: any) {
      db.prepare(`UPDATE plan_workouts SET push_status = 'failed', push_error = ? WHERE id = ?`).run(e.message, w.id);
      return reply.code(502).send({ error: e.message });
    }
  });
}
