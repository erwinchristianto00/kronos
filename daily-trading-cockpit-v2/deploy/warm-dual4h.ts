import {config} from 'dotenv';
import {dirname,resolve} from 'node:path';
config({path:resolve(dirname(process.argv[1]!),'../.env'),quiet:true});
async function main(){
const {BinanceClient}=await import('../apps/api/src/lib/binance.js');
const {Dual4hCollection}=await import('../apps/api/src/lib/dual4h-collection.js');
const client=new BinanceClient();
const collection=new Dual4hCollection('data/dual4h-collection.json',url=>client.fetchFuturesPublic(url,'dual4h_predeploy_warmup'));
await collection.maintain();
console.log(JSON.stringify(collection.status()));collection.close();process.exit(0);

}
main().catch(error=>{console.error(String(error));process.exit(1);});
