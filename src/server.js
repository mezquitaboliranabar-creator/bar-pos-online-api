require("dotenv").config();

// Importa la aplicación Express configurada
const app = require("./app");

// Importa la función para conectar a la base de datos MongoDB
const { connectDB } = require("./config/db");

// Define el puerto del servidor HTTP
const PORT = process.env.PORT || 4000;

// Conecta a la base de datos y luego inicia el servidor HTTP
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bar POS Online API escuchando en el puerto ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("No se pudo iniciar el servidor:", error.message);
  });
