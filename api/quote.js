const https = require('https');
module.exports=function handler(req,res){
res.setHeader('Access-Control-Allow-Origin','*');
res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
res.setHeader('Access-Control-Allow-Headers','Content-Type');
if(req.method==='OPTIONS')return res.status(200).end();
if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
const symbol=(req.query.symbol||'').replace(/[^A-Z0-9.\-]/g,'').slice(0,10).toUpperCase();
if(!symbol)return res.status(400).json({error:'Symbol required'});
const key=process.env.FINNHUB_API_KEY;
if(!key)return res.status(500).json({error:'Not configured'});
https.get('https://finnhub.io/api/v1/quote?symbol='+symbol+'&token='+key,function(r){
let d='';
r.on('data',function(c){d+=c;});
r.on('end',function(){
try{
const q=JSON.parse(d);
if(!q||!q.c)return res.status(404).json({error:'No data'});
return res.status(200).json({price:q.c,open:q.o,high:q.h,low:q.l,prevClose:q.pc,change:((q.c-q.pc)/q.pc)*100});
}catch(e){return res.status(500).json({error:'Error'});}
});
}).on('error',function(){return res.status(500).json({error:'Error'});});
};
