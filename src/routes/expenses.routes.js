const express = require("express");
const Expense = require("../models/Expense");
const { authMiddleware } = require("./auth.routes");

// Crea el router para agrupar las rutas de gastos
const router = express.Router();

// Valida permisos de administrador
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res
      .status(403)
      .json({ ok: false, error: "Acceso restringido a administradores" });
  }
  next();
}

// Normaliza fechas tipo yyyy-mm-dd a rango completo del día
function normalizeRangeDate(value, isStart) {
  if (!value) return null;
  const s = String(value);
  if (s.length === 10) {
    return isStart ? s + " 00:00:00" : s + " 23:59:59";
  }
  return s;
}

// Obtiene un rango de fechas aceptando variantes de query
function getRangeQuery(q) {
  const start = q.start || q.from || q.dateFrom || null;
  const end = q.end || q.to || q.dateTo || null;
  const startNorm = normalizeRangeDate(start, true);
  const endNorm = normalizeRangeDate(end, false);
  return { startNorm, endNorm };
}

// Crea un gasto manual
router.post("/", authMiddleware, async (req, res) => {
  try {
    const amountRaw = req.body?.amount;
    const conceptRaw = req.body?.concept;
    const methodRaw = req.body?.method;
    const providerRaw = req.body?.provider ?? null;
    const categoryRaw = req.body?.category ?? null;
    const noteRaw = req.body?.note ?? null;

    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Monto inválido" });
    }

    const concept = String(conceptRaw || "").trim();
    if (!concept) {
      return res
        .status(400)
        .json({ ok: false, error: "Concepto requerido" });
    }

    const method = String(methodRaw || "").toUpperCase();
    const allowedMethods = new Set(["CASH", "CARD", "TRANSFER", "OTHER"]);
    if (!allowedMethods.has(method)) {
      return res
        .status(400)
        .json({ ok: false, error: "Método de pago inválido" });
    }

    let provider = providerRaw ? String(providerRaw).toUpperCase() : null;
    const allowedProviders = new Set(["NEQUI", "DAVIPLATA"]);
    if (method !== "TRANSFER") {
      provider = null;
    } else if (provider && !allowedProviders.has(provider)) {
      return res
        .status(400)
        .json({ ok: false, error: "Proveedor de transferencia inválido" });
    }

    const category = categoryRaw ? String(categoryRaw).trim() : null;
    const note = noteRaw ? String(noteRaw).trim() : null;

    const created = await Expense.create({
      amount,
      concept,
      method,
      provider,
      category,
      note,
      status: "ACTIVE",
      createdBy: req.user.id,
    });

    return res.json({
      ok: true,
      item: created.toJSON(),
    });
  } catch (error) {
    console.error("Error al crear gasto:", error.message);
    return res.status(500).json({ ok: false, error: "Error al crear gasto" });
  }
});

// Lista gastos con filtros (para modal tipo lista de ventas)
router.get("/", authMiddleware, async (req, res) => {
  try {
    const {
      q = "",
      method,
      status,
      limit = "100",
      offset = "0",
    } = req.query;

    const filter = {};
    const and = [];

    const { startNorm, endNorm } = getRangeQuery(req.query);
    if (startNorm || endNorm) {
      const range = {};
      if (startNorm) range.$gte = new Date(startNorm);
      if (endNorm) range.$lte = new Date(endNorm);
      and.push({ createdAt: range });
    }

    if (method) {
      and.push({ method: String(method).toUpperCase() });
    }

    if (status) {
      and.push({ status: String(status).toUpperCase() });
    }

    const qTrim = String(q || "").trim();
    if (qTrim) {
      const rx = new RegExp(qTrim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      and.push({
        $or: [{ concept: rx }, { category: rx }, { note: rx }],
      });
    }

    if (and.length > 0) {
      filter.$and = and;
    }

    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);

    const items = await Expense.find(filter)
      .populate("createdBy", "username name role")
      .sort({ createdAt: -1, _id: -1 })
      .skip(off)
      .limit(lim);

    return res.json({
      ok: true,
      items: items.map((it) => it.toJSON()),
      total: items.length,
    });
  } catch (error) {
    console.error("Error al listar gastos:", error.message);
    return res.status(500).json({ ok: false, error: "Error al listar gastos" });
  }
});

// Anula un gasto sin eliminarlo
router.put("/:id/void", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const reasonRaw = req.body?.reason ?? req.body?.voidReason ?? null;
    const reason = reasonRaw ? String(reasonRaw).trim() : null;

    const expense = await Expense.findById(id);
    if (!expense) {
      return res.status(404).json({ ok: false, error: "Gasto no encontrado" });
    }

    if (expense.status === "VOID") {
      return res.status(400).json({ ok: false, error: "El gasto ya está anulado" });
    }

    expense.status = "VOID";
    expense.voidedAt = new Date();
    expense.voidedBy = req.user.id;
    expense.voidReason = reason || "Anulado";

    await expense.save();

    return res.json({
      ok: true,
      item: expense.toJSON(),
    });
  } catch (error) {
    console.error("Error al anular gasto:", error.message);
    return res.status(500).json({ ok: false, error: "Error al anular gasto" });
  }
});

// Exporta el router para montarlo en app.js
module.exports = {
  expensesRouter: router,
};
