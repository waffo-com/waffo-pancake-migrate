// ISO 4217 List One (SIX), retrieved 2026-10-10. Do not use locale display rounding.
// https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
export const CURRENCY_MINOR_UNITS = new Map<string, number>([
  ..."BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF"
    .split(" ")
    .map((code) => [code, 0] as [string, number]),
  ..."AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XAD XCD XCG YER ZAR ZMW ZWG"
    .split(" ")
    .map((code) => [code, 2] as [string, number]),
  ..."BHD IQD JOD KWD LYD OMR TND"
    .split(" ")
    .map((code) => [code, 3] as [string, number]),
  ..."CLF UYW".split(" ").map((code) => [code, 4] as [string, number]),
]);

/** Integer ISO minor units to a display amount, without binary floating-point rounding. */
export function minorUnitsToDisplay(
  amount: unknown,
  currency: unknown
): string {
  if (typeof currency !== "string" || !CURRENCY_MINOR_UNITS.has(currency))
    throw new Error("Unsupported currency");
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0)
    throw new Error("Invalid minor-unit amount");
  const digits = CURRENCY_MINOR_UNITS.get(currency)!;
  const value = String(amount).padStart(digits + 1, "0");
  return digits === 0
    ? value
    : `${value.slice(0, -digits)}.${value.slice(-digits)}`;
}
