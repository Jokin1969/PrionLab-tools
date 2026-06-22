"""Add query_name column to prionvault_pubmed_inventory."""
from sqlalchemy import text

def upgrade(conn):
    conn.execute(text("""
        ALTER TABLE prionvault_pubmed_inventory
        ADD COLUMN IF NOT EXISTS query_name VARCHAR(100) DEFAULT 'prion'
    """))
    conn.execute(text("""
        UPDATE prionvault_pubmed_inventory SET query_name = 'prion' WHERE query_name IS NULL
    """))

def downgrade(conn):
    conn.execute(text("""
        ALTER TABLE prionvault_pubmed_inventory DROP COLUMN IF EXISTS query_name
    """))
