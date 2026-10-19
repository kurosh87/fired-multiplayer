import {createGateway} from './gateway.ts';
import {gatewayNodes} from './gateway-routing.ts';
import {parseTrustedProxyCidrs} from './runtime-config.ts';

const port=Number(process.env.GATEWAY_PORT??8788);
if(process.env.PUBLIC_RELEASE==='true')throw new Error('Public release is gated: qualify hosted accounts, original gameplay and distributed capacity first.');
if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('Invalid GATEWAY_PORT.');
if(!process.env.WORKER_NODES_JSON||!process.env.WEB_ORIGIN)
  throw new Error('Configure WORKER_NODES_JSON, WEB_ORIGIN and one dedicated account provider.');
const gateway=await createGateway({origin:process.env.WEB_ORIGIN,nodes:gatewayNodes(JSON.parse(process.env.WORKER_NODES_JSON)),
  supabaseUrl:process.env.SUPABASE_URL,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY,
  accountOrigin:process.env.ACCOUNT_ORIGIN,accountDatabaseUrl:process.env.ACCOUNT_DATABASE_URL,accountSecret:process.env.BETTER_AUTH_SECRET,
  trustedProxyCidrs:parseTrustedProxyCidrs(process.env.TRUST_PROXY_CIDRS)});
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void gateway.close().then(()=>process.exit(0));});
await gateway.listen({host:process.env.HOST??'127.0.0.1',port});
