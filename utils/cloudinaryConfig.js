'use strict';

// If your project already configures Cloudinary elsewhere (e.g. for
// restaurant images), skip this file and point utils/riderUpload.js at
// that existing instance instead — calling .config() twice with the same
// env vars is harmless, but there's no need for two copies.

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

module.exports = cloudinary;
