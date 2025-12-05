const mongoose = require("mongoose");

// Lee la URL de conexión desde las variables de entorno
const MONGO_URI = process.env.MONGO_URI;

// Valida que exista la URL de conexión
if (!MONGO_URI) {
  throw new Error("MONGO_URI no está definida en las variables de entorno");
}

// Define la función que inicia la conexión con MongoDB
async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Conectado a MongoDB");
  } catch (error) {
    console.error("Error al conectar a MongoDB:", error.message);
    process.exit(1);
  }
}

// Exporta la función de conexión para usarla en otros módulos
module.exports = {
  connectDB,
};
