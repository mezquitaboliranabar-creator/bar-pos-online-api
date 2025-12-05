const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Crea un router de Express para agrupar las rutas de autenticación
const router = express.Router();

// Lee valores de configuración para generar y validar tokens
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "2h";

// Define un middleware para validar el token JWT en rutas protegidas
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ ok: false, error: "Token no proporcionado" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.id,
      username: payload.username,
      name: payload.name,
      role: payload.role,
    };
    next();
  } catch (_error) {
    return res.status(401).json({ ok: false, error: "Token inválido o expirado" });
  }
}

// Define la ruta de login para validar credenciales y devolver un token JWT
router.post("/login", async (req, res) => {
  try {
    const { username, pin } = req.body;

    if (!username || !pin) {
      return res.status(400).json({ ok: false, error: "Usuario y PIN son requeridos" });
    }

    const user = await User.findOne({ username });

    if (!user || !user.isActive) {
      return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
    }

    const isValidPin = await bcrypt.compare(pin, user.pinHash);

    if (!isValidPin) {
      return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
    }

    const payload = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.json({
      ok: true,
      token,
      user: user.toJSON(),
    });
  } catch (error) {
    console.error("Error en login:", error);
    return res.status(500).json({ ok: false, error: "Error interno en login" });
  }
});

// Define la ruta para obtener los datos del usuario autenticado
router.get("/me", authMiddleware, (req, res) => {
  return res.json({
    ok: true,
    user: req.user,
  });
});

// Exporta el router y el middleware para usarlos en la aplicación principal
module.exports = {
  authRouter: router,
  authMiddleware,
};
