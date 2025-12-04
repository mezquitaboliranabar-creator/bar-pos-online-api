require("dotenv").config();

// Importa la aplicación Express
const app = require("./app");

// Define el puerto del servidor
const PORT = process.env.PORT || 4000;

// Inicia el servidor HTTP
app.listen(PORT, () => {
  console.log(`Bar POS Online API escuchando en el puerto ${PORT}`);
});
