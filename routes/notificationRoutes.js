const express=require('express');const router=express.Router();const {protect}=require('../middleware/authMiddleware');const c=require('../controllers/notificationController');
router.get('/',protect,c.list);router.patch('/:id/read',protect,c.markRead);module.exports=router;
