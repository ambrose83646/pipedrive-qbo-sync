-- PostgreSQL Schema for Pipedrive-QuickBooks Integration App
-- This replaces the Replit key-value store with proper relational tables

-- Users table: stores OAuth tokens and service credentials
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    pipedrive_user_id VARCHAR(255) UNIQUE NOT NULL,
    
    -- Pipedrive OAuth
    pipedrive_access_token TEXT,
    pipedrive_refresh_token TEXT,
    pipedrive_expires_at TIMESTAMP,
    pipedrive_api_domain VARCHAR(255),
    
    -- QuickBooks OAuth
    qb_access_token TEXT,
    qb_refresh_token TEXT,
    qb_realm_id VARCHAR(100),
    qb_expires_at TIMESTAMP,
    qb_last_refresh TIMESTAMP,
    
    -- ShipStation credentials (encrypted)
    shipstation_api_key TEXT,
    shipstation_api_secret TEXT,
    shipstation_auto_create BOOLEAN DEFAULT FALSE,
    shipstation_connected_at TIMESTAMP,
    
    -- Setup flow tokens
    setup_token TEXT,
    setup_token_expires TIMESTAMP,
    
    -- Setup preferences (stored as JSONB for flexibility)
    invoice_preferences JSONB,
    
    -- Legacy setup fields (kept for backward compatibility)
    invoice_item_field VARCHAR(100),
    invoice_qty_field VARCHAR(100),
    invoice_price_field VARCHAR(100),
    setup_completed BOOLEAN DEFAULT FALSE,
    setup_completed_at TIMESTAMP,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Deal mappings: links Pipedrive deals to QuickBooks customers
CREATE TABLE IF NOT EXISTS deal_mappings (
    id SERIAL PRIMARY KEY,
    deal_id VARCHAR(100) UNIQUE NOT NULL,
    qb_customer_id VARCHAR(100) NOT NULL,
    customer_name VARCHAR(255),
    linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Pending invoices: tracks invoices waiting for payment (for ShipStation automation)
CREATE TABLE IF NOT EXISTS pending_invoices (
    id SERIAL PRIMARY KEY,
    invoice_id VARCHAR(100) UNIQUE NOT NULL,
    invoice_number VARCHAR(100),
    user_id VARCHAR(255) NOT NULL,
    invoice_data JSONB,
    retry_count INTEGER DEFAULT 0,
    last_error TEXT,
    last_attempt TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Invoice mappings: links QuickBooks invoices to ShipStation orders
CREATE TABLE IF NOT EXISTS invoice_mappings (
    id SERIAL PRIMARY KEY,
    invoice_id VARCHAR(100) UNIQUE NOT NULL,
    invoice_number VARCHAR(100),
    shipstation_order_id VARCHAR(100),
    shipstation_order_number VARCHAR(100),
    triggered_by VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_users_pipedrive_id ON users(pipedrive_user_id);
CREATE INDEX IF NOT EXISTS idx_deal_mappings_deal_id ON deal_mappings(deal_id);
CREATE INDEX IF NOT EXISTS idx_pending_invoices_user_id ON pending_invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_invoices_retry_count ON pending_invoices(retry_count);
CREATE INDEX IF NOT EXISTS idx_invoice_mappings_invoice_id ON invoice_mappings(invoice_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for auto-updating updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_pending_invoices_updated_at ON pending_invoices;
CREATE TRIGGER update_pending_invoices_updated_at
    BEFORE UPDATE ON pending_invoices
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
