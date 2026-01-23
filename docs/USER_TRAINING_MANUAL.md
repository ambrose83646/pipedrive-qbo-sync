# QuickBooks Integration for Pipedrive
## User Training Manual

Welcome to the QuickBooks Integration for Pipedrive! This guide will walk you through all the features of this app and how to use them effectively.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Connecting to QuickBooks](#connecting-to-quickbooks)
3. [Linking Deals to QuickBooks Customers](#linking-deals-to-quickbooks-customers)
4. [Creating Invoices](#creating-invoices)
5. [Viewing Invoice History](#viewing-invoice-history)
6. [ShipStation Integration](#shipstation-integration)
7. [Settings and Configuration](#settings-and-configuration)
8. [Troubleshooting](#troubleshooting)

---

## Getting Started

After your administrator installs the app, you'll see new panels and options appear within your Pipedrive account. The integration adds the following features:

- **QuickBooks Connection Panel** - Connect your QuickBooks account
- **Contact Linking Panel** - Link Pipedrive deals to QuickBooks customers
- **Invoicing Panel** - Create and manage invoices directly from deals
- **Settings Page** - Configure ShipStation and other preferences

---

## Connecting to QuickBooks

Before you can create invoices or link customers, you need to connect your QuickBooks account.

### Step 1: Open the Settings Page
1. In Pipedrive, navigate to **Apps & Integrations**
2. Find the QuickBooks Integration app
3. Click on **Settings**

### Step 2: Connect Your QuickBooks Account
1. Click the **Connect QuickBooks** button
2. A new window will open asking you to sign in to your QuickBooks account
3. Select the QuickBooks company you want to connect
4. Click **Authorize** to grant the app permission to access your QuickBooks data

### Step 3: Verify Connection
Once connected, you'll see:
- A green "Connected" status
- Your QuickBooks company name displayed
- Options to disconnect or reconnect if needed

**Note:** The connection will automatically refresh in the background, so you shouldn't need to reconnect unless you manually disconnect.

---

## Linking Deals to QuickBooks Customers

Before creating invoices for a deal, you need to link the Pipedrive deal to a QuickBooks customer.

### Opening the Contact Panel
1. Open any deal in Pipedrive
2. Look for the **QuickBooks** panel on the right side of the deal view
3. The panel shows the current link status

### Linking a Deal to a Customer

**If the customer already exists in QuickBooks:**
1. Click the **Link to Customer** button
2. Search for the customer by name
3. Select the matching customer from the list
4. Click **Confirm** to create the link

**If the customer doesn't exist in QuickBooks:**
1. Click **Create New Customer**
2. The customer's information from Pipedrive will be used to create a new QuickBooks customer
3. Review the information and click **Create**
4. The deal will automatically be linked to the new customer

### Viewing Linked Status
When a deal is linked:
- You'll see the QuickBooks customer name displayed
- The customer's billing address and email will be shown
- An **Unlink** button will appear if you need to change the connection

### Unlinking a Deal
1. Click the **Unlink** button
2. Confirm that you want to remove the connection
3. The deal will no longer be associated with that QuickBooks customer

**Note:** Unlinking a deal does not delete any invoices already created for that customer.

---

## Creating Invoices

Once a deal is linked to a QuickBooks customer, you can create invoices directly from Pipedrive.

### Opening the Invoice Panel
1. Open the linked deal in Pipedrive
2. Look for the **Invoicing** panel
3. Click **Create Invoice** to open the invoice form

### Invoice Form Fields

**Customer Information (Auto-filled)**
- Customer name from QuickBooks
- Billing address
- Email address (for sending invoice)

**Invoice Details**
- **Invoice Date**: When the invoice is issued (defaults to today)
- **Due Date**: When payment is expected
- **Terms**: Payment terms (Net 30, Due on Receipt, etc.)

**Line Items**
Each line item includes:
- **Product/Service**: Search and select from your QuickBooks products
- **Description**: Auto-filled from product, but can be edited
- **Quantity**: Number of items
- **Rate**: Price per item
- **Amount**: Automatically calculated (Quantity x Rate)

### Adding Line Items
1. Click **Add Line Item**
2. Start typing in the Product/Service field to search
3. Select the product from the dropdown
4. Adjust quantity and rate as needed
5. The amount will calculate automatically

### Applying Discounts
1. Scroll to the **Discount** section
2. Choose discount type:
   - **Percentage** (e.g., 10%)
   - **Fixed Amount** (e.g., $50)
3. Enter the discount value
4. The total will update in real-time

### Invoice Summary
At the bottom of the form, you'll see:
- **Subtotal**: Sum of all line items
- **Discount**: Any discount applied
- **Total**: Final amount due

### Creating the Invoice
1. Review all information
2. Check the **Send email to customer** box if you want QuickBooks to email the invoice
3. Click **Create Invoice**
4. The invoice will be created in QuickBooks and linked to the deal

---

## Viewing Invoice History

You can view all invoices for a linked customer directly from Pipedrive.

### Opening the Invoice List
1. Open the linked deal
2. In the Invoicing panel, click **View All Invoices**
3. A modal will open showing all invoices for that customer

### Invoice List Features

**Overview Summary**
At the top, you'll see:
- Total number of invoices
- Total amount invoiced
- Outstanding balance
- Paid amount

**Date Range Filter**
- Use the date selector to filter invoices by date range
- Click **Apply** to update the list

**Invoice Table**
Each invoice shows:
- Invoice number
- Date created
- Due date
- Total amount
- Balance due
- Status (Paid, Open, Overdue)
- Shipping status (if ShipStation is connected)

### Invoice Actions

**View Details**
- Click on any invoice to expand and see line items
- Shows product name, quantity, rate, and amount for each item

**Download PDF**
- Click the **PDF** button to download the invoice as a PDF
- The file will download to your computer

**Copy Payment Link**
- Click the **Payment Link** button
- A shareable link is copied to your clipboard
- Send this link to customers for online payment

---

## ShipStation Integration

If your organization uses ShipStation for shipping, the app can automatically create orders when invoices are paid.

### How It Works

1. When you create an invoice with "Due on Receipt" terms, the app monitors it for payment
2. Once the invoice is marked as paid in QuickBooks, a ShipStation order is automatically created
3. The order includes all the invoice details needed for fulfillment

### Viewing Shipping Status

In the Invoice List, each invoice shows its shipping status:

| Status | Meaning |
|--------|---------|
| **No Order** | No ShipStation order exists yet |
| **Awaiting Shipment** | Order created, waiting to be shipped |
| **Shipped** | Order has been shipped |
| **Delivered** | Package delivered to customer |

### Shipment Tracking
- When an order is shipped, a tracking number appears
- Click the tracking number to view carrier tracking information

---

## Settings and Configuration

### Accessing Settings
1. Go to **Apps & Integrations** in Pipedrive
2. Find the QuickBooks Integration
3. Click **Settings**

### QuickBooks Connection
- View your current connection status
- Disconnect and reconnect if needed
- See which QuickBooks company is connected

### ShipStation Configuration
If your admin has enabled ShipStation:
1. Enter your ShipStation API Key
2. Enter your ShipStation API Secret
3. Click **Save**

**Note:** ShipStation credentials are shared across your organization. Only one person needs to set this up.

### Testing the Connection
After entering ShipStation credentials:
1. Click **Test Connection**
2. If successful, you'll see a green confirmation
3. If there's an error, verify your API credentials are correct

---

## Troubleshooting

### Common Issues and Solutions

**"QuickBooks Not Connected" Message**
- Go to Settings and click **Connect QuickBooks**
- Complete the authorization process
- Return to the deal and refresh the page

**Can't Find Customer When Linking**
- Make sure the customer exists in QuickBooks
- Try searching with different name variations
- If the customer is new, use **Create New Customer**

**Invoice Not Appearing in QuickBooks**
- Wait a few seconds and refresh
- Check your QuickBooks account directly
- Verify your connection is still active

**ShipStation Order Not Created**
- Verify ShipStation credentials are entered in Settings
- Order creation happens automatically for Net 30 and Net 60 invoices
- Orders are created automatically when Due on Receipt invoices are marked as paid
- Wait up to 5 minutes for the system to detect payment

**Payment Link Not Working**
- Ensure the invoice exists in QuickBooks
- Check that online payments are enabled in your QuickBooks settings
- The customer may need to be set up for online invoicing

### Getting Help

If you continue to experience issues:
1. Take note of any error messages displayed
2. Check which screen/panel you were using
3. Contact your Pipedrive administrator
4. Your admin can check the app logs for detailed error information

---

## Quick Reference

### Keyboard Shortcuts
- **Tab**: Move between form fields
- **Enter**: Submit forms / Confirm actions
- **Esc**: Close modals

### Status Icons

| Icon/Color | Meaning |
|------------|---------|
| Green | Connected / Paid / Success |
| Orange | Pending / Outstanding |
| Red | Error / Overdue |
| Gray | Not connected / No data |

### Invoice Payment Terms

| Term | Description |
|------|-------------|
| Due on Receipt | Payment expected immediately upon receipt |
| Net 30 | Payment due within 30 days |
| Net 60 | Payment due within 60 days |

---

## Best Practices

1. **Always link deals first** before creating invoices
2. **Verify customer information** is correct before invoicing
3. **Use product search** to maintain consistent pricing
4. **Enable email sending** for faster payment collection
5. **Check invoice status** regularly to follow up on overdue payments
6. **Keep ShipStation credentials secure** - only administrators should configure this

---

*Last updated: January 2026*
