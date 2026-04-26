/**
 * BuildOS Shared Supplier Module
 * 
 * Provides supplier catalog, product management, and order tracking
 * with commission calculation. Used by all trade apps.
 * 
 * Revenue model: 1-3% commission on in-app material orders.
 */

import { query, queryOne, run } from '@krusch/toolkit/db';
import { v4 as uuidv4 } from 'uuid';

// ==========================================
// Schema (call initSupplierTables() at app startup)
// ==========================================

export function initSupplierTables() {
  run(`CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    website TEXT,
    api_url TEXT,
    commission_pct REAL DEFAULT 2.0,
    supported_trades TEXT DEFAULT '[]',
    regions TEXT DEFAULT '[]',
    contact_name TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    hours TEXT,
    access_code TEXT UNIQUE,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  run(`CREATE TABLE IF NOT EXISTS supplier_products (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    trade TEXT NOT NULL,
    sku TEXT,
    name TEXT NOT NULL,
    description TEXT,
    brand TEXT,
    category TEXT DEFAULT 'General',
    unit_price REAL NOT NULL,
    unit TEXT DEFAULT 'each',
    pack_size INTEGER,
    in_stock INTEGER DEFAULT 1,
    image_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  run(`CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    estimate_id TEXT NOT NULL,
    product_id TEXT REFERENCES supplier_products(id),
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,
    total_price REAL NOT NULL,
    commission_pct REAL NOT NULL,
    commission_amount REAL NOT NULL,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  run(`CREATE INDEX IF NOT EXISTS idx_products_trade ON supplier_products(trade)`);
  run(`CREATE INDEX IF NOT EXISTS idx_products_supplier ON supplier_products(supplier_id)`);
  run(`CREATE INDEX IF NOT EXISTS idx_products_category ON supplier_products(category)`);
  run(`CREATE INDEX IF NOT EXISTS idx_orders_estimate ON order_items(estimate_id)`);
}

// ==========================================
// Supplier CRUD
// ==========================================

export function createSupplier(data) {
  const id = uuidv4();
  const accessCode = uuidv4().slice(0, 8).toUpperCase();
  run(
    `INSERT INTO suppliers (id, name, website, api_url, commission_pct, supported_trades, regions, contact_name, phone, email, address, hours, access_code, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, data.name, data.website || null, data.api_url || null,
      data.commission_pct || 2.0,
      JSON.stringify(data.supported_trades || []),
      JSON.stringify(data.regions || []),
      data.contact_name || null, data.phone || null, data.email || null,
      data.address || null, data.hours || null, accessCode, data.notes || null,
    ]
  );
  return queryOne('SELECT * FROM suppliers WHERE id = ?', [id]);
}

export function getSupplier(id) {
  return queryOne('SELECT * FROM suppliers WHERE id = ?', [id]);
}

export function getSupplierByCode(code) {
  return queryOne('SELECT * FROM suppliers WHERE access_code = ?', [code]);
}

export function listSuppliers(trade = null) {
  if (trade) {
    return query(
      `SELECT * FROM suppliers WHERE supported_trades LIKE ? ORDER BY name`,
      [`%"${trade}"%`]
    );
  }
  return query('SELECT * FROM suppliers ORDER BY name');
}

export function updateSupplier(id, data) {
  const supplier = getSupplier(id);
  if (!supplier) return null;

  run(
    `UPDATE suppliers SET name = ?, website = ?, commission_pct = ?, contact_name = ?,
     phone = ?, email = ?, address = ?, hours = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      data.name ?? supplier.name, data.website ?? supplier.website,
      data.commission_pct ?? supplier.commission_pct,
      data.contact_name ?? supplier.contact_name,
      data.phone ?? supplier.phone, data.email ?? supplier.email,
      data.address ?? supplier.address, data.hours ?? supplier.hours,
      data.notes ?? supplier.notes, id,
    ]
  );
  return getSupplier(id);
}

// ==========================================
// Product Catalog
// ==========================================

export function addProduct(supplierId, trade, data) {
  const id = uuidv4();
  run(
    `INSERT INTO supplier_products (id, supplier_id, trade, sku, name, description, brand, category, unit_price, unit, pack_size, in_stock, image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, supplierId, trade,
      data.sku || null, data.name, data.description || null,
      data.brand || null, data.category || 'General',
      data.unit_price || data.price, data.unit || 'each',
      data.pack_size || null, data.in_stock !== false ? 1 : 0,
      data.image_url || null,
    ]
  );
  return queryOne('SELECT * FROM supplier_products WHERE id = ?', [id]);
}

export function addProductsBulk(supplierId, trade, products) {
  const added = [];
  for (const p of products) {
    added.push(addProduct(supplierId, trade, p));
  }
  return added;
}

export function getProducts(trade = null, category = null, search = null) {
  let sql = 'SELECT p.*, s.name as supplier_name FROM supplier_products p JOIN suppliers s ON p.supplier_id = s.id WHERE 1=1';
  const params = [];

  if (trade) {
    sql += ' AND p.trade = ?';
    params.push(trade);
  }
  if (category) {
    sql += ' AND p.category = ?';
    params.push(category);
  }
  if (search) {
    sql += ' AND (p.name LIKE ? OR p.brand LIKE ? OR p.sku LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY p.category, p.name';
  return query(sql, params);
}

export function getSupplierProducts(supplierId) {
  return query(
    'SELECT * FROM supplier_products WHERE supplier_id = ? ORDER BY category, name',
    [supplierId]
  );
}

export function updateProduct(productId, data) {
  const product = queryOne('SELECT * FROM supplier_products WHERE id = ?', [productId]);
  if (!product) return null;

  run(
    `UPDATE supplier_products SET name = ?, sku = ?, description = ?, brand = ?,
     category = ?, unit_price = ?, unit = ?, pack_size = ?, in_stock = ?,
     image_url = ?, updated_at = datetime('now') WHERE id = ?`,
    [
      data.name ?? product.name, data.sku ?? product.sku,
      data.description ?? product.description, data.brand ?? product.brand,
      data.category ?? product.category, data.unit_price ?? product.unit_price,
      data.unit ?? product.unit, data.pack_size ?? product.pack_size,
      data.in_stock !== undefined ? (data.in_stock ? 1 : 0) : product.in_stock,
      data.image_url ?? product.image_url, productId,
    ]
  );
  return queryOne('SELECT * FROM supplier_products WHERE id = ?', [productId]);
}

export function deleteProduct(productId) {
  run('DELETE FROM supplier_products WHERE id = ?', [productId]);
  return { deleted: true };
}

// ==========================================
// Order Management & Commission
// ==========================================

export function createOrderItem(estimateId, productId, quantity) {
  const product = queryOne(
    'SELECT p.*, s.commission_pct FROM supplier_products p JOIN suppliers s ON p.supplier_id = s.id WHERE p.id = ?',
    [productId]
  );
  if (!product) throw new Error('Product not found');

  const id = uuidv4();
  const totalPrice = Math.round(product.unit_price * quantity * 100) / 100;
  const commissionPct = product.commission_pct || 2.0;
  const commissionAmount = Math.round(totalPrice * (commissionPct / 100) * 100) / 100;

  run(
    `INSERT INTO order_items (id, estimate_id, product_id, product_name, quantity, unit_price, total_price, commission_pct, commission_amount, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
    [id, estimateId, productId, product.name, quantity, product.unit_price, totalPrice, commissionPct, commissionAmount]
  );
  return queryOne('SELECT * FROM order_items WHERE id = ?', [id]);
}

export function getEstimateOrders(estimateId) {
  const items = query('SELECT * FROM order_items WHERE estimate_id = ? ORDER BY created_at', [estimateId]);
  const totalCost = items.reduce((sum, i) => sum + i.total_price, 0);
  const totalCommission = items.reduce((sum, i) => sum + i.commission_amount, 0);

  return {
    items,
    totals: {
      itemCount: items.length,
      totalCost: Math.round(totalCost * 100) / 100,
      totalCommission: Math.round(totalCommission * 100) / 100,
    },
  };
}

export function updateOrderStatus(orderId, status) {
  run(
    `UPDATE order_items SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    [status, orderId]
  );
  return queryOne('SELECT * FROM order_items WHERE id = ?', [orderId]);
}

// ==========================================
// Product Categories (per trade)
// ==========================================

export const TRADE_CATEGORIES = {
  electrical: ['Wire & Cable', 'Boxes & Fittings', 'Devices', 'Plates & Covers', 'Panel Components', 'Conduit & Raceway', 'Connectors & Fasteners', 'Lighting', 'Safety'],
  plumbing: ['Pipe & Fittings', 'Valves', 'Fixtures', 'Water Heaters', 'Drain Components', 'Tools & Supplies', 'Safety'],
  framing: ['Lumber', 'Engineered Wood', 'Fasteners', 'Connectors & Hardware', 'Sheathing', 'Tools'],
  hvac: ['Ductwork', 'Equipment', 'Controls', 'Refrigerant', 'Filters', 'Insulation', 'Tools'],
  drywall: ['Board', 'Compound & Tape', 'Fasteners', 'Corner Bead', 'Tools', 'Primers'],
  painting: ['Interior Paint', 'Exterior Paint', 'Stains & Sealers', 'Primers', 'Supplies', 'Equipment'],
  roofing: ['Shingles', 'Underlayment', 'Flashing', 'Fasteners', 'Ventilation', 'Gutters'],
  flooring: ['Hardwood', 'Tile', 'LVP/LVT', 'Carpet', 'Adhesives & Grout', 'Underlayment', 'Trim & Transitions'],
  masonry: ['Brick', 'Block', 'Mortar', 'Rebar', 'Stone Veneer', 'Tools'],
  landscaping: ['Pavers', 'Stone', 'Soil & Mulch', 'Plants', 'Irrigation', 'Lighting', 'Fencing'],
};

export function getCategoriesForTrade(trade) {
  return TRADE_CATEGORIES[trade] || ['General'];
}
