const express=require('express');const router=express.Router();const {protect}=require('../middleware/authMiddleware');const c=require('../controllers/notificationController');const push=require('../services/pushService');
router.get('/',protect,c.list);router.patch('/:id/read',protect,c.markRead);
router.post('/register-token',protect,async(req,res)=>{try{await push.registerToken(req.user._id,String((req.body&&req.body.token)||''));res.json({success:true});}catch(e){res.status(e.statusCode||500).json({success:false,message:e.message});}});
router.post('/unregister-token',protect,async(req,res)=>{try{await push.unregisterToken(req.user._id,String((req.body&&req.body.token)||''));res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}});
module.exports=router;
