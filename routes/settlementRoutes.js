const express=require('express');const router=express.Router();const {protect,authorize}=require('../middleware/authMiddleware');const {requirePermission}=require('../middleware/permissionMiddleware');const c=require('../controllers/settlementController');
router.post('/rebuild',protect,authorize('admin'),requirePermission('finance.manage'),c.rebuildLedger);router.get('/',protect,authorize('admin'),requirePermission('finance.manage'),c.listLedger);router.post('/settle',protect,authorize('admin'),requirePermission('finance.manage'),c.settle);router.get('/integrity',protect,authorize('admin'),requirePermission('finance.manage'),c.integrity);
// Pillar 5 — restaurant settlement management.
router.get('/restaurants',protect,authorize('admin'),requirePermission('finance.manage'),c.listRestaurantSettlements);
router.get('/restaurants/:id/statement',protect,authorize('admin'),requirePermission('finance.manage'),c.getRestaurantStatement);
router.post('/restaurants/:id/adjustment',protect,authorize('admin'),requirePermission('finance.manage'),c.createRestaurantAdjustment);
router.post('/batches',protect,authorize('admin'),requirePermission('finance.manage'),c.createSettlementBatch);
router.get('/export.csv',protect,authorize('admin'),requirePermission('finance.manage'),c.exportSettlementsCsv);
// Pillar 6 — rider earnings + COD cash reconciliation.
router.get('/riders',protect,authorize('admin'),requirePermission('finance.manage'),c.listRiderSettlements);
router.get('/riders/:id/ledger',protect,authorize('admin'),requirePermission('finance.manage'),c.getRiderLedger);
router.post('/riders/:id/cod-deposit',protect,authorize('admin'),requirePermission('finance.manage'),c.recordRiderCodDeposit);
router.post('/riders/:id/payout',protect,authorize('admin'),requirePermission('finance.manage'),c.settleRiderPayout);
module.exports=router;
