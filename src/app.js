const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

// Importa el router de autenticación
const { authRouter } = require("./routes/auth.routes");

// Importa el router de usuarios
const { usersRouter } = require("./routes/users.routes");

// Importa dl router de productos
const { productsRouter } = require("./routes/products.routes");

// Importa el router de inventario 
const { inventoryRouter } = require("./routes/inventory.routes");

// Importa el router de ventas
const { salesRouter } = require("./routes/sales.routes");
const { recipesRouter } = require("./routes/recipes.routes");

// Importa el router de tabs
const { tabsRouter } = require("./routes/tabs.routes");






// Crea la instancia de la aplicación Express
const app = express();

// Configura middlewares de seguridad y CORS
app.use(helmet());
app.use(
  cors({
    origin: "*",
  })
);

// Habilita parseo de JSON en el cuerpo de las peticiones
app.use(express.json());

// Agrega logger HTTP para registrar las peticiones
app.use(morgan("dev"));

// Define una ruta de salud para verificar el estado del servicio
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Bar POS Online API",
  });
});

// Define una ruta raíz simple para comprobación general
app.get("/", (req, res) => {
  res.json({
    message: "Bar POS Online API",
  });
});

// Monta las rutas de autenticación bajo el prefijo /api/auth
app.use("/api/auth", authRouter);

// Monta las rutas de usuarios bajo el prefijo /api/users
app.use("/api/users", usersRouter);

// Monta las rutas de productos bajo el prefijo /api/products
app.use("/api/products", productsRouter);

// Monta las rutas de inventario bajo el prefijo /api/inventory/moves
app.use("/api/inventory", inventoryRouter);

// Monta las rutas de ventas bajo el prefijo /api/sales /api/sales/catalog /api/sales/payments/summary
app.use("/api/sales", salesRouter);

// Monta las rutas de tabs bajo el prefijo /api/tabs
app.use("/api/tabs", tabsRouter);

app.use("/api/recipes", recipesRouter);

// Exporta la aplicación configurada para usarla en server.js
module.exports = app;
