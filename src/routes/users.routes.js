const express = require("express");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { authMiddleware } = require("./auth.routes");

// Crea el router para agrupar las rutas de usuarios
const router = express.Router();

// Define un middleware para asegurar que el usuario tenga rol admin
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Acceso restringido a administradores" });
  }
  next();
}

// Define la ruta para obtener la lista de usuarios
router.get("/", authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const users = await User.find().sort({ createdAt: 1 });
    return res.json({
      ok: true,
      users: users.map((u) => u.toJSON()),
    });
  } catch (error) {
    console.error("Error al listar usuarios:", error.message);
    return res.status(500).json({ ok: false, error: "Error al listar usuarios" });
  }
});

// Define la ruta para crear un nuevo usuario
router.post("/", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { username, name, role, pin } = req.body;

    if (!username || !name || !role || !pin) {
      return res.status(400).json({ ok: false, error: "username, name, role y pin son requeridos" });
    }

    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(409).json({ ok: false, error: "El nombre de usuario ya existe" });
    }

    if (!["admin", "vendedor"].includes(role)) {
      return res.status(400).json({ ok: false, error: "role inválido" });
    }

    const pinHash = await bcrypt.hash(pin, 10);

    const user = await User.create({
      username,
      name,
      role,
      pinHash,
      isActive: true,
    });

    return res.status(201).json({
      ok: true,
      user: user.toJSON(),
    });
  } catch (error) {
    console.error("Error al crear usuario:", error.message);
    return res.status(500).json({ ok: false, error: "Error al crear usuario" });
  }
});

// Define la ruta para actualizar un usuario existente
router.put("/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, isActive, pin } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ ok: false, error: "Usuario no encontrado" });
    }

    if (name !== undefined) {
      user.name = name;
    }

    if (role !== undefined) {
      if (!["admin", "vendedor"].includes(role)) {
        return res.status(400).json({ ok: false, error: "role inválido" });
      }
      user.role = role;
    }

    if (typeof isActive === "boolean") {
      user.isActive = isActive;
    }

    if (pin) {
      const pinHash = await bcrypt.hash(pin, 10);
      user.pinHash = pinHash;
    }

    await user.save();

    return res.json({
      ok: true,
      user: user.toJSON(),
    });
  } catch (error) {
    console.error("Error al actualizar usuario:", error.message);
    return res.status(500).json({ ok: false, error: "Error al actualizar usuario" });
  }
});

// Exporta el router configurado para usuarios
module.exports = {
  usersRouter: router,
};
