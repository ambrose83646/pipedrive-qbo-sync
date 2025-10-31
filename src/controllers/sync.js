const { getUser } = require('../../config/database');
const pipedrive = require('pipedrive');
const OAuthClient = require('intuit-oauth');

async function syncContact(pipedriveUserId, personId) {
  try {
    // 1. Get user tokens from Replit DB
    console.log(`Starting sync for user: ${pipedriveUserId}, person: ${personId}`);
    const userData = await getUser(pipedriveUserId);
    
    if (!userData) {
      throw new Error('User not found in database');
    }

    if (!userData.access_token || !userData.qb_access_token) {
      throw new Error('Missing required tokens');
    }

    // 2. Initialize Pipedrive client with OAuth access token
    const apiClient = pipedrive.ApiClient.instance;
    const oauth2 = apiClient.authentications.oauth2;
    oauth2.accessToken = userData.access_token;
    
    // If api_domain is available, set the base path
    if (userData.api_domain) {
      apiClient.basePath = `https://${userData.api_domain}.pipedrive.com/api/v1`;
    }

    // 3. Fetch person from Pipedrive
    const personsApi = new pipedrive.PersonsApi();
    console.log(`Fetching person ${personId} from Pipedrive...`);
    
    const personResponse = await personsApi.getPerson(personId);
    const person = personResponse.data;
    
    if (!person) {
      throw new Error('Person not found in Pipedrive');
    }

    console.log(`Found person: ${person.name}`);

    // 4. Map Pipedrive fields to QuickBooks fields
    const qbCustomerData = {
      DisplayName: person.name || 'Unknown',
      PrimaryEmailAddr: person.email && person.email.length > 0 ? {
        Address: person.email[0].value
      } : undefined,
      PrimaryPhone: person.phone && person.phone.length > 0 ? {
        FreeFormNumber: person.phone[0].value
      } : undefined
    };

    // 5. Initialize QuickBooks OAuth client
    const qbClient = new OAuthClient({
      clientId: process.env.QB_CLIENT_ID,
      clientSecret: process.env.QB_CLIENT_SECRET,
      environment: 'sandbox', // Change to 'production' for live
      redirectUri: process.env.APP_URL + '/auth/qb/callback',
      logging: false
    });

    // Set the access token
    qbClient.setToken({
      access_token: userData.qb_access_token,
      refresh_token: userData.qb_refresh_token,
      token_type: 'Bearer',
      expires_in: userData.qb_expires_in,
      x_refresh_token_expires_in: 8726400,
      realmId: userData.qb_realm_id
    });

    const companyId = userData.qb_realm_id;
    const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
    
    // 6. Check if customer exists in QuickBooks
    const query = `SELECT * FROM Customer WHERE DisplayName = '${person.name.replace(/'/g, "\\'")}'`;
    const encodedQuery = encodeURIComponent(query);
    
    console.log(`Querying QuickBooks for existing customer...`);
    
    let existingCustomer = null;
    try {
      const queryResponse = await qbClient.makeApiCall({
        url: `${baseUrl}/v3/company/${companyId}/query?query=${encodedQuery}`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      const queryResult = JSON.parse(queryResponse.text());
      if (queryResult.QueryResponse && queryResult.QueryResponse.Customer && queryResult.QueryResponse.Customer.length > 0) {
        existingCustomer = queryResult.QueryResponse.Customer[0];
        console.log(`Found existing customer with ID: ${existingCustomer.Id}`);
      }
    } catch (queryError) {
      console.log('Customer not found, will create new one');
    }

    let qbCustomerId;
    
    if (existingCustomer) {
      // 7a. Update existing customer (sparse update)
      console.log(`Updating customer ${existingCustomer.Id}...`);
      
      const updateData = {
        ...qbCustomerData,
        Id: existingCustomer.Id,
        SyncToken: existingCustomer.SyncToken,
        sparse: true
      };

      const updateResponse = await qbClient.makeApiCall({
        url: `${baseUrl}/v3/company/${companyId}/customer?minorversion=65`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      });

      const updatedCustomer = JSON.parse(updateResponse.text()).Customer;
      qbCustomerId = updatedCustomer.Id;
      console.log(`Successfully updated customer ${qbCustomerId}`);
      
    } else {
      // 7b. Create new customer
      console.log('Creating new customer...');
      
      const createResponse = await qbClient.makeApiCall({
        url: `${baseUrl}/v3/company/${companyId}/customer?minorversion=65`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(qbCustomerData)
      });

      const newCustomer = JSON.parse(createResponse.text()).Customer;
      qbCustomerId = newCustomer.Id;
      console.log(`Successfully created customer ${qbCustomerId}`);
    }

    // 8. Log success and return result
    console.log(`Sync completed successfully! QB Customer ID: ${qbCustomerId}`);
    
    return {
      success: true,
      qbCustomerId: qbCustomerId,
      action: existingCustomer ? 'updated' : 'created',
      pipedrivePersonId: personId,
      pipedrivePersonName: person.name
    };

  } catch (error) {
    console.error('Sync error:', error);
    throw error;
  }
}

module.exports = {
  syncContact
};