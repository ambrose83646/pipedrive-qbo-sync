const express = require('express');
const router = express.Router();
const { getUser, setUser } = require('../../config/database');

router.get('/', (req, res) => {
  res.send('Hello!');
});

router.get('/test-db', async (req, res) => {
  try {
    const testData = { name: 'Test User', token: 'fake' };
    await setUser('test123', testData);
    const retrievedData = await getUser('test123');
    res.json(retrievedData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
