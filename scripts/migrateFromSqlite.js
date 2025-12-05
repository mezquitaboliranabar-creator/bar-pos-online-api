

// Carga variables de entorno y dependencias base
require("dotenv").config();
const path = require("path");
const Database = require("better-sqlite3");
const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");

// Modelos de Mongo
const User = require("../src/models/User");
const Product = require("../src/models/Product");
const InventoryMove = require("../src/models/InventoryMove");
const Sale = require("../src/models/Sale");
const SaleItem = require("../src/models/SaleItem");
const Payment = require("../src/models/Payment");
const SaleReturn = require("../src/models/SaleReturn");

// Abre la base de datos SQLite del POS local
function openSqlite() {
  const defaultPath = path.join(__dirname, "..", "data", "pos.sqlite");
  const dbPath = process.env.SQLITE_PATH || defaultPath;
  const db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

// Migra usuarios de SQLite a Mongo y devuelve mapa id antiguo -> ObjectId
async function migrateUsers(db) {
  const rows = db.prepare("SELECT * FROM users").all();
  const map = new Map();

  for (const row of rows) {
    const username = String(row.username).trim();
    let user = await User.findOne({ username }).exec();

    if (!user) {
      user = await User.create({
        username,
        name: String(row.name || "").trim(),
        role: row.role === "admin" ? "admin" : "vendedor",
        pinHash: row.pin_hash,
        passwordHash: row.pin_hash,
        isActive: row.is_active === 0 ? false : true,
      });
    }

    map.set(row.id, user._id);
  }

  console.log(`Usuarios migrados o enlazados: ${rows.length}`);
  return map;
}

// Migra productos de SQLite a Mongo y devuelve mapa id antiguo -> ObjectId
async function migrateProducts(db) {
  const rows = db.prepare("SELECT * FROM products").all();
  const map = new Map();

  for (const row of rows) {
    const name = String(row.name).trim();
    const category = String(row.category || "").trim();

    let product = await Product.findOne({ name, category }).exec();

    const rawKind = String(row.kind || "STANDARD").toUpperCase();
    const kindValues = ["STANDARD", "BASE", "ACCOMP", "COCKTAIL"];
    const kind = kindValues.includes(rawKind) ? rawKind : "STANDARD";

    const rawInvType = String(row.inv_type || "UNIT").toUpperCase();
    const invTypeValues = ["UNIT", "BASE", "ACCOMP"];
    const inv_type = invTypeValues.includes(rawInvType) ? rawInvType : "UNIT";

    let defaultMeasure = "UNIT";
    if (inv_type === "BASE") defaultMeasure = "ML";
    if (inv_type === "ACCOMP") defaultMeasure = "UNIT";

    const rawMeasure = String(row.measure || defaultMeasure).toUpperCase();

    const isActive =
      row.is_active === 0 || row.is_active === false ? false : true;

    if (!product) {
      product = await Product.create({
        name,
        category,
        price: Number(row.price || 0),
        stock: Number(row.stock || 0),
        min_stock: Number(row.min_stock || 0),
        is_active: isActive,
        kind,
        inv_type,
        measure: rawMeasure,
      });
    } else {
      let updated = false;
      if (product.kind !== kind) {
        product.kind = kind;
        updated = true;
      }
      if (product.inv_type !== inv_type) {
        product.inv_type = inv_type;
        updated = true;
      }
      if (product.measure !== rawMeasure) {
        product.measure = rawMeasure;
        updated = true;
      }
      if (updated) {
        await product.save();
      }
    }

    map.set(row.id, product._id);
  }

  console.log(`Productos migrados o enlazados: ${rows.length}`);
  return map;
}

// Migra movimientos de inventario de SQLite a Mongo
async function migrateInventoryMoves(db, productMap, userMap) {
  const rows = db.prepare("SELECT * FROM inventory_moves").all();
  let created = 0;

  for (const row of rows) {
    const productId = productMap.get(row.product_id);
    if (!productId) {
      console.warn(
        `Inventario sin producto mapeado, product_id=${row.product_id}`
      );
      continue;
    }

    const userId = userMap.get(row.user_id) || null;

    await InventoryMove.create({
      product: productId,
      qty: Number(row.qty || 0),
      note: row.note || "",
      user: userId,
      type: row.type || null,
      sourceRef: row.source_ref || null,
      location: row.location || null,
      supplierId: row.supplier_id || null,
      supplierName: row.supplier_name || null,
      invoiceNumber: row.invoice_number || null,
      unitCost: row.unit_cost != null ? Number(row.unit_cost) : null,
      discount: row.discount != null ? Number(row.discount) : null,
      tax: row.tax != null ? Number(row.tax) : null,
      lot: row.lot || null,
      expiryDate: row.expiry_date || null,
    });

    created += 1;
  }

  console.log(`Movimientos de inventario migrados: ${created}`);
}

// Migra ventas y entidades relacionadas de SQLite a Mongo
async function migrateSales(db, productMap, userMap) {
  const saleRows = db.prepare("SELECT * FROM sales").all();
  const itemRows = db.prepare("SELECT * FROM sale_items").all();
  const paymentRows = db.prepare("SELECT * FROM payments").all();
  const returnRows = db.prepare("SELECT * FROM sale_returns").all();

  const saleMap = new Map();
  const saleItemMap = new Map();

  let salesCreated = 0;
  let itemsCreated = 0;
  let paymentsCreated = 0;
  let returnsCreated = 0;

  const fallbackUser =
    (await User.findOne({ role: "admin" }).exec()) ||
    (await User.findOne().exec());
  const fallbackUserId = fallbackUser ? fallbackUser._id : null;

  if (!fallbackUserId) {
    console.warn(
      "No se encontró usuario de respaldo; las ventas sin usuario serán omitidas."
    );
  }

  for (const row of saleRows) {
    const mappedUserId =
      row.user_id != null ? userMap.get(row.user_id) : null;
    const userId = mappedUserId || fallbackUserId;

    if (!userId) {
      console.warn(
        `Venta sin usuario mapeado y sin usuario de respaldo, se omite sale_id=${row.id}`
      );
      continue;
    }

    const saleDoc = await Sale.create({
      user: userId,
      status: row.status,
      subtotal: Number(row.subtotal || 0),
      discount_total: Number(row.discount_total || 0),
      tax_total: Number(row.tax_total || 0),
      total: Number(row.total || 0),
      notes: row.notes || null,
      client: row.client || null,
    });

    saleMap.set(row.id, saleDoc._id);
    salesCreated += 1;
  }

  for (const row of itemRows) {
    const saleId = saleMap.get(row.sale_id);
    const productId = productMap.get(row.product_id);
    if (!saleId || !productId) {
      console.warn(
        `Item sin venta o producto mapeado, sale_id=${row.sale_id}, product_id=${row.product_id}`
      );
      continue;
    }

    const itemDoc = await SaleItem.create({
      sale: saleId,
      product: productId,
      qty: Number(row.qty || 0),
      unit_price: Number(row.unit_price || 0),
      line_discount: Number(row.line_discount || 0),
      tax_rate: row.tax_rate != null ? Number(row.tax_rate) : null,
      tax_amount: Number(row.tax_amount || 0),
      line_total: Number(row.line_total || 0),
      name_snapshot: row.name_snapshot,
      category_snapshot: row.category_snapshot || null,
    });

    saleItemMap.set(row.id, itemDoc._id);
    itemsCreated += 1;
  }

  for (const row of paymentRows) {
  const saleId = saleMap.get(row.sale_id);
  if (!saleId) {
    console.warn(`Pago sin venta mapeada, sale_id=${row.sale_id}`);
    continue;
  }

  const rawAmount = Number(row.amount || 0);
  const amount = rawAmount >= 0 ? rawAmount : 0;

  if (rawAmount < 0) {
    console.warn(
      `Pago con monto negativo ajustado a 0, payment_id=${row.id}, amount=${rawAmount}`
    );
  }

  const rawChange = Number(row.change_given || 0);
  const change_given = rawChange >= 0 ? rawChange : 0;

  await Payment.create({
    sale: saleId,
    method: row.method,
    provider: row.provider || null,
    amount,
    change_given,
    reference: row.reference || null,
  });

  paymentsCreated += 1;
}


  for (const row of returnRows) {
    const saleId = saleMap.get(row.sale_id);
    const saleItemId = saleItemMap.get(row.sale_item_id);
    if (!saleId || !saleItemId) {
      console.warn(
        `Devolución sin venta o item mapeado, sale_id=${row.sale_id}, sale_item_id=${row.sale_item_id}`
      );
      continue;
    }

    await SaleReturn.create({
      sale: saleId,
      sale_item: saleItemId,
      qty: Number(row.qty || 0),
      refund_amount: Number(row.refund_amount || 0),
      note: row.note || null,
    });

    returnsCreated += 1;
  }

  console.log(`Ventas migradas: ${salesCreated}`);
  console.log(`Items de venta migrados: ${itemsCreated}`);
  console.log(`Pagos migrados: ${paymentsCreated}`);
  console.log(`Devoluciones migradas: ${returnsCreated}`);
}

// Ejecuta la migración completa en orden
async function main() {
  await connectDB();
  const db = openSqlite();

  try {
    const userMap = await migrateUsers(db);
    const productMap = await migrateProducts(db);
    await migrateInventoryMoves(db, productMap, userMap);
    await migrateSales(db, productMap, userMap);
  } finally {
    db.close();
    await mongoose.disconnect();
  }

  console.log("Migración desde SQLite completada");
}

// Inicia el proceso si se ejecuta este archivo directamente
if (require.main === module) {
  main().catch((err) => {
    console.error("Error en migración:", err);
    process.exit(1);
  });
}

//npm run migrate:sqlite
