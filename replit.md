# Overview

This is a Node.js integration application that connects Pipedrive CRM with QuickBooks Online (QBO). The application synchronizes contact data from Pipedrive to QuickBooks, allowing users to manage their CRM contacts and accounting customers from a unified interface. The app uses OAuth 2.0 authentication for both services and stores user credentials in Replit's key-value database. It provides browser extensions for Pipedrive that enable users to connect their QuickBooks account and manage contact synchronization directly from within the Pipedrive interface.

**QuickBooks Compliance**: The app follows QuickBooks certification requirements by ensuring users must explicitly click "Connect to QuickBooks" in the app settings rather than automatically redirecting during installation.

**Post-Installation Setup**: After connecting QuickBooks, administrators complete a two-step setup flow:
1. User Authorization - Grant other users permission to create invoices
2. Invoice Preferences - Configure field mappings (name, address, email, tax rate, default account) for automatic invoice population

This setup uses secure tokens with 30-minute expiration to prevent unauthorized access to user preferences.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Application Structure

**Problem**: Need a lightweight server to handle OAuth flows, webhooks, and API requests for two external services.

**Solution**: Express.js application with modular route handling and separated authentication logic.

**Rationale**: Express provides a minimal, flexible framework suitable for API integration tasks. The modular structure separates concerns (routes, auth, controllers, config) making the codebase maintainable as integration complexity grows.

## Authentication Architecture

**Problem**: Need to securely authenticate with both Pipedrive and QuickBooks APIs on behalf of multiple users.

**Solution**: OAuth 2.0 flow implementation for both services with separate authentication modules (`src/auth/pipedrive.js` and `src/auth/quickbooks.js`).

**Key Design Decisions**:
- Uses `intuit-oauth` library for QuickBooks authentication (handles token refresh and validation)
- Custom axios-based implementation for Pipedrive OAuth (more control over request/response handling)
- State parameter encoding to track user context and extension origin during OAuth callbacks
- Sandbox environment for QuickBooks (configured for development/testing)

**Pros**: Secure, industry-standard authentication; libraries handle token refresh complexity.

**Cons**: Requires managing two separate OAuth flows; tokens must be securely stored and refreshed.

## Data Storage

**Problem**: Need persistent storage for user OAuth tokens, realm IDs, and configuration data.

**Solution**: Replit Database (key-value store) with abstraction layer in `config/database.js`.

**Key Design Decisions**:
- Simple key-value storage using Pipedrive user ID as the primary key
- Wrapper functions (getUser, setUser, deleteUser, listUsers) provide a consistent interface
- Stores both Pipedrive and QuickBooks tokens per user in a single record

**Pros**: No infrastructure setup required; simple API; adequate for credential storage.

**Cons**: Limited querying capabilities; not suitable for complex relational data; potential scalability constraints for large user bases.

**Alternatives Considered**: Traditional relational database (PostgreSQL) would provide better query capabilities but adds deployment complexity.

## Frontend Architecture

**Problem**: Need to integrate UI components directly into Pipedrive's interface.

**Solution**: Browser-based Pipedrive App Extensions using the official SDK (`@pipedrive/app-extensions-sdk`).

**Key Design Decisions**:
- Static HTML files served from `public/extensions/` directory
- Extensions include: connection management (`connect.html`) and deal-contact operations (`deal-contact.html`)
- Client-side JavaScript communicates with backend API endpoints

**Pros**: Native integration into Pipedrive UI; familiar user experience.

**Cons**: Limited to Pipedrive's extension capabilities; requires hosting static assets.

## Synchronization Logic

**Problem**: Need to map and transfer contact data between two systems with different data models.

**Solution**: Controller-based sync logic (`src/controllers/sync.js`) that orchestrates data flow.

**Key Design Decisions**:
- Fetches person data from Pipedrive API using stored OAuth tokens
- Maps Pipedrive person fields to QuickBooks customer fields
- Uses official `pipedrive` npm client for API calls
- Handles authentication for both services within the sync function

**Pros**: Centralized sync logic; clear separation of concerns.

**Cons**: Currently appears to be one-way sync (Pipedrive → QuickBooks); potential for data consistency issues if networks fail mid-sync.

# Recent Changes

- **December 2, 2025**: Added invoice list modal for viewing all invoices within Pipedrive
  - Created new `invoice-list-modal.html` extension that opens via Pipedrive SDK (modal ID: 27de700c-7063-46e0-9562-2acb3462ba1d)
  - Displays invoice table with columns: Invoice #, Date, Due Date, Status, Amount, Balance, Action
  - Status badges: Paid (green), Open (orange), Overdue (red) with robust date handling
  - Slide-in detail panel shows line items (products, discounts, taxes, groups), email, shipping address, memos
  - Respects date range filter from the main QuickBooks Manager panel
  - Fixed date parsing to handle QuickBooks YYYY-MM-DD format correctly (prevents off-by-one-day in US time zones)
  - Handles all QuickBooks line detail types: SalesItemLineDetail, DiscountLineDetail, GroupLineDetail (with child expansion), TaxLineDetail, etc.
  - "View all invoices" button now opens this modal instead of external QuickBooks link

- **December 2, 2025**: Added date range selector to QuickBooks Manager panel
  - Dropdown with presets: This Quarter (default), Last Quarter, This Year, Custom
  - Custom range allows picking specific start/end dates
  - Invoice overview data filters by selected date range
  - Fixed cross-browser event handling by passing element references instead of relying on global event

- **December 2, 2025**: Added automatic email option when creating invoices
  - Checkbox "Email invoice to customer" in invoice modal (checked by default when email on file)
  - Displays customer email address and disables checkbox when no email on file
  - Backend calls QuickBooks `/invoice/{id}/send` endpoint after successful creation
  - Success message indicates whether email was sent successfully
  - Email failures don't prevent invoice creation (graceful degradation)

- **December 2, 2025**: Added discount field to invoice modal
  - Users can now apply discounts as either percentage (%) or fixed dollar amount ($)
  - Toggle button switches between discount types with live calculation updates
  - Percentage discounts limited to 100%, fixed discounts clamped to subtotal
  - Visual warning (orange border) when fixed discount exceeds subtotal
  - Summary displays subtotal, discount line, and final total
  - QuickBooks receives DiscountLineDetail as percentage-based to avoid account reference requirements
  - Improved token refresh handling with graceful fallback for missing refresh tokens

- **December 2, 2025**: Enhanced invoice creation with payment terms and customer email
  - Updated payment terms dropdown with three options: Due on Receipt, Net 30, Net 60
  - Added automatic due date calculation when payment terms are selected
  - Invoice modal now fetches customer email from QuickBooks linked contact on load
  - Email is displayed as read-only field in the invoice form and included in QuickBooks invoice via BillEmail field
  - This enables direct invoice emailing from QuickBooks to the customer

- **November 25, 2025**: Fixed contact linking with tenant isolation and database storage
  - Overhauled user lookup to prioritize freshest Pipedrive tokens by `created_at` timestamp
  - Added tenant-safe QB token merging: only merges if api_domain AND qb_realm_id match (prevents cross-tenant credential leakage)
  - Implemented database-based deal-to-QB customer mapping via `setDealMapping`/`getDealMapping` functions
  - Fixed Pipedrive OAuth to use Bearer token in Authorization header (not query string api_token param)
  - Fixed `/api/deal-contact` endpoint to return stored mapping even when QB tokens unavailable
  - **Fixed extension to show linked contacts**: Updated `loadDealData()` to call `/api/deal-contact` endpoint instead of looking for Pipedrive custom field
  - **Fixed customer name display**: Now shows stored customer name (e.g., "Amy's Bird Sanctuary") instead of generic "QuickBooks Customer #X"
  - **Added unlink feature**: Added DELETE `/api/deal-contact` endpoint and "X" button in UI to remove deal-QB contact links
  - Implemented automatic Pipedrive token refresh (similar to QuickBooks refresh logic)
  - Fixed frontend SDK commands: replaced invalid 'TOAST' with `AppExtensionsSDK.Command.SHOW_SNACKBAR`
  - Note: Pipedrive refresh tokens expire after 60 days of non-use; users must re-authenticate if tokens are fully expired

- **November 25, 2025**: Added invoice creation functionality with product search
  - Implemented `/api/items/search` endpoint for searching QuickBooks inventory (products and services)
  - Implemented `/api/invoices` POST endpoint for creating invoices in QuickBooks
  - Built invoice creation modal UI with dynamic line item management
  - Added product search with debounce and dropdown selection (300ms debounce, min 2 chars)
  - Real-time invoice total calculation as line items are added/modified
  - Added "Create Invoice" button to linked state UI alongside "View all invoices"
  - All new endpoints use `makeQBApiCall` helper for automatic token refresh handling

- **November 18, 2025**: Implemented new invoicing panel extension with modern UI design
  - Created professional two-column layout matching QuickBooks design standards
  - Added linked/unlinked states with appropriate visual feedback
  - Integrated real-time invoice data fetching with overview calculations
  - Fixed QuickBooks API response parsing (changed `.text()` to `.body`)
  - Fixed initialization error in deal-contact extension by using URL parameters as primary source
  - Implemented auto-search with dropdown for QuickBooks contact search (triggers at 2+ characters with 300ms debounce)
  - Added proper error handling for search API to prevent console errors
  - Implemented automatic QuickBooks token refresh for all API endpoints to handle expired tokens (1-hour expiry)
  - Fixed token persistence issue to ensure refreshed tokens are saved under the correct user key

# External Dependencies

## Third-Party Services

### Pipedrive CRM
- **Purpose**: Source system for contact/person data
- **Authentication**: OAuth 2.0 (custom implementation)
- **API Access**: RESTful API via `pipedrive` npm package (v30.3.0)
- **Required Scopes**: persons:full, organizations:full, deals:full
- **Configuration**: Requires PIPEDRIVE_CLIENT_ID and PIPEDRIVE_CLIENT_SECRET environment variables

### QuickBooks Online
- **Purpose**: Destination system for customer data synchronization
- **Authentication**: OAuth 2.0 via `intuit-oauth` library (v4.2.0)
- **API Access**: Accounting API
- **Environment**: Sandbox (development mode)
- **Required Scopes**: com.intuit.quickbooks.accounting
- **Configuration**: Requires QB_CLIENT_ID, QB_CLIENT_SECRET, and realm_id (company ID)

## Database

### Replit Database
- **Type**: Key-value store
- **Library**: `@replit/database` (v3.0.1)
- **Usage**: Stores user OAuth tokens, refresh tokens, realm IDs, and API domain information
- **Data Structure**: JSON objects keyed by Pipedrive user ID
- **Stored Fields**: access_token, refresh_token, qb_access_token, qb_refresh_token, qb_realm_id, api_domain, timestamps

## Key NPM Packages

- **express** (v5.1.0): Web server framework
- **axios** (v1.12.2): HTTP client for Pipedrive OAuth flow
- **dotenv** (v17.2.3): Environment variable management
- **intuit-oauth** (v4.2.0): QuickBooks OAuth client
- **pipedrive** (v30.3.0): Official Pipedrive API client

## Environment Variables Required

- `PORT`: Server port (defaults to 3000)
- `APP_URL`: Base URL for OAuth callbacks
- `PIPEDRIVE_CLIENT_ID`: Pipedrive OAuth application ID
- `PIPEDRIVE_CLIENT_SECRET`: Pipedrive OAuth application secret
- `QB_CLIENT_ID`: QuickBooks application ID
- `QB_CLIENT_SECRET`: QuickBooks application secret