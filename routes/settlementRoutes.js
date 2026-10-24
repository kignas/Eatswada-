const asyncHandler=require('express-async-handler');
const express=require('express');const router=express.Router();const {protect,authorize}=require('../middleware/authMiddleware');const {requirePermission}=require('../middleware/permissionMiddleware');const c=require('../controllers/settlementController');
router.post('/rebuild',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.rebuildLedger));router.get('/',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.listLedger));router.post('/settle',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.settle));router.get('/integrity',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.integrity));
// Pillar 5 — restaurant settlement management.
router.get('/restaurants',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.listRestaurantSettlements));
router.get('/restaurants/:id/statement',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.getRestaurantStatement));
router.post('/restaurants/:id/adjustment',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.createRestaurantAdjustment));
router.post('/batches',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.createSettlementBatch));
router.get('/export.csv',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.exportSettlementsCsv));
// Pillar 6 — rider earnings + COD cash reconciliation.
router.get('/riders',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.listRiderSettlements));
router.get('/riders/:id/ledger',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.getRiderLedger));
router.post('/riders/:id/cod-deposit',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.recordRiderCodDeposit));
router.post('/riders/:id/payout',protect,authorize('admin'),requirePermission('finance.manage'),asyncHandler(c.settleRiderPayout));
module.exports=router;
