require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");

// Limpia la base de datos completa de MongoDB
async function clearDatabase() {
  await connectDB();

  const db = mongoose.connection.db;
  const dbName = db.databaseName;

  console.log(`Limpiando base de datos: ${dbName}`);

  await db.dropDatabase();

  console.log(`Base de datos ${dbName} eliminada correctamente`);

  await mongoose.disconnect();
}

// Ejecuta el proceso de limpieza si se llama este archivo directamente
if (require.main === module) {
  clearDatabase()
    .then(() => {
      console.log("Limpieza completada");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Error al limpiar base de datos:", err);
      process.exit(1);
    });
}
