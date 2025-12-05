// node scripts/createAdmin.js

require("dotenv").config();

// Importa la función de conexión a la base de datos
const { connectDB } = require("../src/config/db");

// Importa el modelo de usuario
const User = require("../src/models/User");

// Importa bcrypt para generar el hash del PIN
const bcrypt = require("bcryptjs");

// Define datos básicos del usuario admin temporal
const ADMIN_USERNAME = "Sebastian";
const ADMIN_NAME = "Sebastian Pastrana";
const ADMIN_PIN = "2793";

// Define la función principal que crea el usuario admin si no existe
async function createAdminUser() {
  try {
    await connectDB();

    const existingAdmin = await User.findOne({ username: ADMIN_USERNAME });

    if (existingAdmin) {
      console.log("El usuario admin ya existe:");
      console.log({
        id: existingAdmin.id,
        username: existingAdmin.username,
        name: existingAdmin.name,
        role: existingAdmin.role,
      });
      process.exit(0);
    }

    const pinHash = await bcrypt.hash(ADMIN_PIN, 10);

    const newAdmin = await User.create({
      username: ADMIN_USERNAME,
      name: ADMIN_NAME,
      role: "admin",
      pinHash,
      isActive: true,
    });

    console.log("Usuario admin creado correctamente:");
    console.log({
      id: newAdmin.id,
      username: newAdmin.username,
      name: newAdmin.name,
      role: newAdmin.role,
    });

    process.exit(0);
  } catch (error) {
    console.error("Error al crear el usuario admin:", error.message);
    process.exit(1);
  }
}

// Ejecuta la función principal del script
createAdminUser();
