const express=require('express');const router=express.Router();const {protect,authorize,optionalAuth}=require('../middleware/authMiddleware');const {requirePermission}=require('../middleware/permissionMiddleware');const c=require('../controllers/platformController');
// Customer-safe snapshot (maintenance / shortage / surge / payment / bill policy). No auth required;
// a bearer token only adds the caller's own isFirstOrder + isCodBlocked.
router.get('/public-status',optionalAuth,c.getPublicStatus);
router.get('/settings',protect,authorize('admin'),requirePermission('settings.manage'),c.getSettings);router.put('/settings',protect,authorize('admin'),requirePermission('settings.manage'),c.setSetting);
// Pillar 1/2/3/6 — structured platform configuration (toggles, bill policy, payment engine, rider pay).
router.get('/config',protect,authorize('admin'),requirePermission('settings.manage'),c.getPlatformConfig);router.put('/config',protect,authorize('admin'),requirePermission('settings.manage'),c.updatePlatformConfig);router.get('/bill-policy',protect,authorize('admin'),requirePermission('settings.manage'),c.getBillPolicy);
router.get('/zones',protect,authorize('admin'),requirePermission('settings.manage'),c.listZones);router.post('/zones',protect,authorize('admin'),requirePermission('settings.manage'),c.createZone);router.put('/zones/:id',protect,authorize('admin'),requirePermission('settings.manage'),c.updateZone);router.delete('/zones/:id',protect,authorize('admin'),requirePermission('settings.manage'),c.deleteZone);module.exports=router;
