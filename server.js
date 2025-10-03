require('dotenv').config();
const express = require('express');
const routes = require('./src/routes/index');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/', routes);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
