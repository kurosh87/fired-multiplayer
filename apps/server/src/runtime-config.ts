import { isIP } from 'node:net';

/** Forwarded headers are trusted only through explicitly configured ingress
 * addresses. Boolean/hop-count trust cannot authenticate the immediate peer. */
export function parseTrustedProxyCidrs(value:string|undefined):string[]|undefined{
  if(!value?.trim())return undefined;
  const entries=value.split(',').map(entry=>entry.trim());
  for(const entry of entries){
    const [address,prefix,...extra]=entry.split('/'),version=isIP(address??'');
    if(!version||extra.length||prefix!==undefined&&(!/^\d{1,3}$/.test(prefix)||Number(prefix)>(version===4?32:128)))
      throw new Error('TRUST_PROXY_CIDRS must contain explicit IPv4/IPv6 addresses or CIDRs.');
    if(prefix!==undefined&&Number(prefix)===0)throw new Error('TRUST_PROXY_CIDRS cannot trust every address.');
  }
  return [...new Set(entries)];
}
