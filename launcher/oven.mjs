#!/usr/bin/env node
// launch.mjs — Lane C : lancer notre token sur StonkFun (courbe Raydium LaunchLab), transaction construite par nous.
// (23/09/2026) Seul chemin ouvert : GET /stats → paidLaunchesEnabled=false, launchLabEnabled=true, devBuysEnabled=true.
// Construction conforme à https://www.stonkfun.xyz/developers (« Building it yourself »), avec la signature RÉELLE du
// SDK Raydium 0.2.70 (mintProgramB en paramètre, règle de courbe en dernier argument) — l'exemple de la doc est périmé.
//
// Modes :
//   simuler --plan journal/lancements/<id>.json [--payeur <adresse>]
//   simuler --quote SOL [--taxe 0|100|300] [--achat 0.05] [--payeur <adresse>]
//       construit la transaction et la SIMULE sur mainnet : aucune signature, aucun envoi, aucun paiement.
//   envoyer --plan journal/lancements/<id>.json
//       LE VRAI LANCEMENT. Uniquement sur le VPS (clé dans .env.launch), déclenché par Al depuis Telegram
//       (/lancement <id> puis /lancer <id> <code>, voir bot.mjs). Claude ne déclenche jamais ce mode lui-même.
//       Étapes : garde-fous → journal d'intention → envoi de l'image et de la fiche sur Irys (payé ≈ 0,00001 SOL) →
//       [paire non-SOL : conversion SOL → actif de la paire par Jupiter, simulée puis confirmée] →
//       simulation obligatoire → signature → envoi → confirmation → vérification de l'adoption par StonkFun.
//       (23/09/2026) Pourquoi convertir : sur 87 000 lancements cashback, les paires SOL décollent à 1,5 %, contre 4,0 % pour
//       les paires crypto/memecoins et 4,4 % pour les actions pré-IPO. L'achat de départ se paie dans l'actif de la paire.
//
// Le signal propose, le CODE dispose : tous les plafonds ci-dessous sont vérifiés ici, pas par un clic.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  buyExactInInstruction, getPdaCreatorVault, getPdaLaunchpadAuth, getPdaLaunchpadPoolId, getPdaLaunchpadVaultId,
  getPdaPlatformVault, initializeWithToken2022,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import bs58 from "bs58";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Version publique (Stocklana, 23/09/2026) : la racine est le dossier du dépôt, où vivent .env.launch et journal/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const API = "https://www.stonkfun.xyz/api/public/v1";
// Portefeuille de la lane C, créé sur le VPS le 23/09 par tools/wallet-new.mjs (adresse publique, pas un secret).
const PORTEFEUILLE_LANCEMENT = "DLbWvWFunGKs5WQ1VdzTNYW4FTExPHY5NVC77cQkDx5";
const FICHIER_CLE = join(ROOT, ".env.launch");
const REGISTRE = join(ROOT, "journal", "launch-ledger.jsonl"); // journal d'intention : écrit AVANT chaque action
const SENTINELLE_KILL = join(ROOT, "journal", "LAUNCH_KILL"); // présence = aucun lancement possible
// Mesuré en simulation le 23/09 : création seule ≈ 98 000 unités, création + achat ≈ 192 000 → plafond 300 000.
const UNITES_CALCUL = 300_000;
// Priorité : 200 000 micro-lamports par unité × 300 000 unités = 0,00006 SOL, assez pour passer sans surpayer (23/09/2026).
// (23/09/2026, après-midi) Relevé à 1 000 000 × 300 000 unités = 0,0003 SOL : le premier baker-bot, à 200 000, a expiré sans
// jamais être inclus, alors que la conversion Jupiter, payée ≈ 0,0002 SOL, passait en 2 secondes.
const PRIX_UNITE_MICROLAMPORTS = 1_000_000;
// Envoi : on renvoie la même transaction toutes les 2 s tant que son blockhash est valide ; s'il expire, on la reconstruit avec
// un blockhash frais, trois fois au plus. Sans risque de doublon : une transaction expirée ne peut plus jamais passer.
const TENTATIVES_ENVOI = 3;
// Plafond de la taxe prélevée par transfert, repris tel quel de l'exemple officiel (en unités brutes du token).
const TAXE_PLAFOND_BRUT = "1000000000000000";
// Achat de départ plafonné à 0,25 SOL (≈ 30 $) : l'enveloppe de la lane C est 1 SOL pour dix essais (21/09/2026).
const ACHAT_MAX_SOL = 0.25;
// Dix lancements au plus sur cette enveloppe (21/09/2026) ; au-delà, on fait le bilan avant de continuer.
const MAX_LANCEMENTS = 10;
// Réserve gardée sur le portefeuille pour la location des comptes, les frais et Irys (mesuré ≈ 0,02 SOL par lancement).
const RESERVE_SOL = 0.03;
// Frais de courbe LaunchLab : 1 % (doc StonkFun, 23/09/2026) ; sert à estimer les tokens reçus.
const FRAIS_COURBE = 0.01;
// Marge de glissement sur l'achat de départ : la courbe est intacte dans la même transaction, 10 % suffit largement.
const MARGE_ACHAT = 0.9;
// Adoption par StonkFun : ils relisent les pools chaque minute ; essai-1 a été adopté en 3 min 30, on attend jusqu'à 8 minutes.
const ATTENTE_ADOPTION_MS = 8 * 60_000;
// Conversion SOL → actif de la paire par l'API publique de Jupiter (sans clé, vérifiée le 23/09/2026).
const JUPITER = "https://lite-api.jup.ag/swap/v1";
// Glissement toléré sur la conversion : 1 %. Impact de prix maximal : 2 %. Mesuré le 23/09 pour 0,05 SOL : ZEC 0,06 %,
// HYPE 0,01 %, OPENAI 0,34 %, TTWO 0,12 %, xStocks ≈ 0 % ; refusés : ANTHROPIC 2,5 %, GP 6,5 % (actifs trop peu échangés).
const GLISSEMENT_BPS = 100;
const IMPACT_MAX_PCT = 2;
// Un plan peut élargir le glissement (champ glissementBps) pour un actif peu échangé, jamais au-delà de 3 % : le 23/09, la
// conversion 0,1 SOL → FIGUREAI à 1 % échouait deux fois sur trois en simulation (erreur Jupiter 6001, glissement dépassé).
const GLISSEMENT_MAX_BPS = 300;
// Chaque tentative de conversion repart d'un devis frais ; trois tentatives au plus avant d'abandonner.
const TENTATIVES_CONVERSION = 3;
// Plafond des frais de priorité de la conversion : 0,0002 SOL.
const PRIORITE_CONVERSION_MAX_LAMPORTS = 200_000;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (nom, def) => { const i = args.indexOf(`--${nom}`); return i > -1 && args[i + 1] ? args[i + 1] : def; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = () => { console.error("usage : node tools/launch.mjs simuler --plan <fichier> | simuler --quote SOL [...] | envoyer --plan <fichier>"); process.exit(1); };
if (!["simuler", "envoyer"].includes(cmd)) usage();

const lireEnv = (fichier) => {
  try {
    return Object.fromEntries(readFileSync(fichier, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
  } catch { return {}; }
};
const env = lireEnv(join(ROOT, ".env"));
const rpc = process.env.SOLANA_RPC || (env.HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_KEY}` : "https://api.mainnet-beta.solana.com");
const connection = new Connection(rpc, "confirmed");
const get = async (chemin) => {
  const r = await fetch(API + chemin, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${chemin} → ${j?.error?.code}: ${j?.error?.message}`);
  return j.data;
};
const registre = () => (existsSync(REGISTRE) ? readFileSync(REGISTRE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const noter = (entree) => appendFileSync(REGISTRE, JSON.stringify({ t: new Date().toISOString(), ...entree }) + "\n");

// ————— le plan : un fichier JSON par lancement, versionné dans le dépôt —————
let plan;
if (opt("plan")) {
  const chemin = opt("plan");
  const brut = readFileSync(chemin, "utf8");
  plan = { ...JSON.parse(brut), code: createHash("sha256").update(brut).digest("hex").slice(0, 6) };
  for (const champ of ["id", "nom", "symbole", "description", "image", "paire"]) if (!plan[champ]) throw new Error(`plan : champ « ${champ} » manquant`);
  if (!/^[a-z0-9-]{3,40}$/.test(plan.id)) throw new Error("plan : id en minuscules, chiffres et tirets");
  if (Buffer.byteLength(plan.nom) > 32 || Buffer.byteLength(plan.symbole) > 10) throw new Error("plan : nom ≤ 32 octets et symbole ≤ 10 octets");
  plan.taxe = Number(plan.taxe ?? 0);
  plan.achatSol = Number(plan.achatSol ?? 0);
} else {
  if (cmd === "envoyer") usage();
  plan = { id: "essai-libre", nom: opt("nom", "Essai simulation"), symbole: opt("symbole", "ESSAI"), paire: opt("quote", ""),
    taxe: Number(opt("taxe", "0")), achatSol: Number(opt("achat", "0")), code: "-" };
}

// ————— garde-fous : le code refuse ce qui sort du cadre —————
if (!(plan.achatSol >= 0 && plan.achatSol <= ACHAT_MAX_SOL)) throw new Error(`achat ${plan.achatSol} SOL refusé : plafond ${ACHAT_MAX_SOL} SOL`);
const historique = registre();
if (cmd === "envoyer") {
  if (!existsSync(FICHIER_CLE)) throw new Error("clé de lancement absente : ce mode ne tourne que sur le VPS");
  if (existsSync(SENTINELLE_KILL)) throw new Error("sentinelle LAUNCH_KILL posée : aucun lancement");
  // Un plan ne part qu'une fois. Une tentative « expiré ou inconnu » n'est rejouable que si son token n'existe pas on-chain ;
  // une tentative restée « envoyé » sans suite bloque tout (en vol ou processus interrompu : à vérifier à la main).
  const duPlan = historique.filter((e) => e.id === plan.id);
  if (duPlan.some((e) => ["confirmé", "adopté", "non adopté"].includes(e.statut))) throw new Error(`plan « ${plan.id} » déjà lancé : un plan ne part qu'une fois`);
  const derniere = duPlan[duPlan.length - 1];
  if (derniere?.statut === "envoyé") throw new Error(`plan « ${plan.id} » : une tentative est restée « envoyé », vérifier avant de relancer`);
  if (derniere?.statut === "expiré ou inconnu" && derniere.mint && (await connection.getAccountInfo(new PublicKey(derniere.mint), "confirmed"))) {
    noter({ id: plan.id, statut: "confirmé", mint: derniere.mint, signature: derniere.signature, taxe: plan.taxe, note: "trouvé on-chain après coup" });
    throw new Error(`plan « ${plan.id} » : la tentative précédente a finalement abouti (${derniere.mint})`);
  }
  const faits = new Set(historique.filter((e) => e.statut === "confirmé").map((e) => e.id));
  if (faits.size >= MAX_LANCEMENTS) throw new Error(`${MAX_LANCEMENTS} lancements atteints : bilan d'abord`);
  if (plan.taxe && !historique.some((e) => e.statut === "adopté" && e.taxe === 0))
    throw new Error("mode cashback refusé : la doc impose d'abord un lancement standard adopté par StonkFun");
}

// 1. La paire doit être lançable ici ET avoir sa config LaunchLab sur la chaîne.
const { pairs } = await get("/pairs?launchable=true&launchLabReady=true");
const candidates = pairs.filter((p) => p.mint === plan.paire || p.symbol.toLowerCase() === String(plan.paire).toLowerCase());
if (candidates.length !== 1) throw new Error(`paire « ${plan.paire} » : ${candidates.length} correspondance(s), donner le mint exact`);
const pair = candidates[0];
const estSol = pair.mint === NATIVE_MINT.toBase58();
const programmeB = new PublicKey(pair.tokenProgram);
const glissementBps = Number(plan.glissementBps ?? GLISSEMENT_BPS);
if (!(glissementBps >= 10 && glissementBps <= GLISSEMENT_MAX_BPS)) throw new Error(`glissement ${glissementBps} refusé : entre 10 et ${GLISSEMENT_MAX_BPS} points de base`);
let devis = null; // devis Jupiter de la conversion, pour une paire non-SOL
const obtenirDevis = async () => {
  const lamports = Math.round(plan.achatSol * 1e9);
  const r = await fetch(`${JUPITER}/quote?inputMint=${NATIVE_MINT.toBase58()}&outputMint=${pair.mint}&amount=${lamports}&slippageBps=${glissementBps}&restrictIntermediateTokens=true`, { signal: AbortSignal.timeout(30000) });
  const d = await r.json();
  if (!d?.outAmount) throw new Error(`conversion SOL → ${pair.symbol} impossible : pas de route Jupiter`);
  const impact = +d.priceImpactPct * 100;
  if (impact > IMPACT_MAX_PCT) throw new Error(`conversion refusée : impact ${impact.toFixed(2)} % au-delà de ${IMPACT_MAX_PCT} % (actif trop peu échangé)`);
  return d;
};
// Construit la transaction de conversion sur un devis frais et la simule ; recommence jusqu'à TENTATIVES_CONVERSION fois.
const conversionSimulee = async (proprietaire) => {
  let derniere = null;
  for (let i = 1; i <= TENTATIVES_CONVERSION; i++) {
    if (i > 1) { await sleep(2000); devis = await obtenirDevis(); }
    const c = await transactionConversion(proprietaire);
    const sim = await connection.simulateTransaction(c.tx, { sigVerify: false, replaceRecentBlockhash: true });
    derniere = { ...c, sim, tentative: i };
    if (!sim.value.err) return derniere;
  }
  return derniere;
};
const transactionConversion = async (proprietaire) => {
  const r = await fetch(`${JUPITER}/swap`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ quoteResponse: devis, userPublicKey: proprietaire.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: PRIORITE_CONVERSION_MAX_LAMPORTS, priorityLevel: "high" } } }),
  });
  const j = await r.json();
  if (!j?.swapTransaction) throw new Error("Jupiter n'a pas fourni la transaction de conversion");
  return { tx: VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, "base64")), lastValidBlockHeight: j.lastValidBlockHeight };
};
const soldeJeton = async (compte) => { try { return BigInt((await connection.getTokenAccountBalance(compte, "confirmed")).value.amount); } catch { return 0n; } };
// Reprise : si une tentative précédente de CE plan a déjà converti le SOL et que l'actif est toujours sur le portefeuille, on le
// réutilise tel quel, sans nouveau devis ni contrôle d'impact. (23/09/2026) La relance de baker-bot a été bloquée par un impact
// passé de 0,3 % à 3,5 % alors que les jetons Figure AI étaient déjà détenus.
const convPrecedente = historique.filter((e) => e.id === plan.id && e.statut === "conversion confirmée").pop();
let reprise = null;
if (plan.achatSol > 0 && !estSol && convPrecedente?.recu) {
  const titulaire = new PublicKey(cmd === "envoyer" ? PORTEFEUILLE_LANCEMENT : opt("payeur", PORTEFEUILLE_LANCEMENT));
  const detenu = await soldeJeton(getAssociatedTokenAddressSync(new PublicKey(pair.mint), titulaire, false, programmeB));
  if (detenu >= BigInt(convPrecedente.recu)) reprise = BigInt(convPrecedente.recu);
}
if (plan.achatSol > 0 && !estSol && reprise == null) devis = await obtenirDevis();

// 2. La courbe : chiffres de la plateforme, jamais les constantes du SDK.
const pricing = await get(`/launchlab/pricing?quoteMint=${pair.mint}`);
if (plan.taxe && !pricing.modes.reward.transferFeeBps.includes(plan.taxe)) throw new Error(`taxe ${plan.taxe} : taux non publié`);
const mode = plan.taxe ? "reward" : "standard";

// 3. Qui paie : en simulation, un payeur fictif possible ; en vrai, uniquement notre portefeuille, clé lue sur le VPS.
let createurKp = null;
if (cmd === "envoyer") {
  const e = lireEnv(FICHIER_CLE);
  createurKp = Keypair.fromSecretKey(bs58.decode(e.LAUNCH_WALLET_SECRET));
  if (createurKp.publicKey.toBase58() !== PORTEFEUILLE_LANCEMENT) throw new Error("la clé ne correspond pas au portefeuille de lancement");
}
const payeur = createurKp ? createurKp.publicKey : new PublicKey(opt("payeur", PORTEFEUILLE_LANCEMENT));
const createur = new PublicKey(PORTEFEUILLE_LANCEMENT);
const solde = await connection.getBalance(payeur);
if (cmd === "envoyer" && solde / 1e9 < plan.achatSol + RESERVE_SOL)
  throw new Error(`solde ${solde / 1e9} SOL insuffisant : il faut ${plan.achatSol} + ${RESERVE_SOL} de réserve`);

const mintKp = Keypair.generate(); // le futur token : une clé jetable, utile seulement pour signer la création
const mint = mintKp.publicKey;
if (cmd === "envoyer") noter({ id: plan.id, statut: "intention", code: plan.code, mint: mint.toBase58(), taxe: plan.taxe, achatSol: plan.achatSol, paire: pair.symbol });

// 4. La fiche du token sur Irys (stockage permanent, celui qu'utilise StonkFun). En simulation : adresse fictive.
let uri = "https://example.com/metadata.json", imageUrl = null;
if (cmd === "envoyer") {
  const { Uploader } = await import("@irys/upload");
  const { Solana } = await import("@irys/upload-solana");
  const irys = await Uploader(Solana).withWallet(bs58.encode(createurKp.secretKey)).withRpc(rpc);
  const image = readFileSync(join(ROOT, plan.image));
  const typeImage = plan.image.endsWith(".png") ? "image/png" : "image/jpeg";
  const prix = BigInt((await irys.getPrice(image.length)).toString()) + BigInt((await irys.getPrice(2048)).toString());
  await irys.fund(((prix * 12n) / 10n).toString()); // 20 % de marge ; le reste reste crédité chez Irys pour la suite
  const recuImage = await irys.upload(image, { tags: [{ name: "Content-Type", value: typeImage }] });
  imageUrl = `https://gateway.irys.xyz/${recuImage.id}`;
  const fiche = {
    name: plan.nom, symbol: plan.symbole, description: plan.description, image: imageUrl, showName: true,
    ...(plan.twitter ? { twitter: plan.twitter } : {}), ...(plan.telegram ? { telegram: plan.telegram } : {}),
    ...(plan.website ? { website: plan.website } : {}),
  };
  const recuFiche = await irys.upload(Buffer.from(JSON.stringify(fiche)), { tags: [{ name: "Content-Type", value: "application/json" }] });
  uri = `https://gateway.irys.xyz/${recuFiche.id}`;
  noter({ id: plan.id, statut: "fiche en ligne", mint: mint.toBase58(), image: imageUrl, uri });
}

// 5. L'instruction de création, puis l'achat de départ dans la même transaction.
const programId = new PublicKey(pricing.curve.programId);
const platformId = new PublicKey(pricing.platform[mode]);
const configId = new PublicKey(pricing.curve.configId);
const auth = getPdaLaunchpadAuth(programId).publicKey;
const quoteMint = new PublicKey(pair.mint);
const { publicKey: poolId } = getPdaLaunchpadPoolId(programId, mint, quoteMint);
const vaultA = getPdaLaunchpadVaultId(programId, poolId, mint).publicKey;
const vaultB = getPdaLaunchpadVaultId(programId, poolId, quoteMint).publicKey;
const ix = initializeWithToken2022(
  programId, payeur, createur, configId, platformId, auth, poolId, mint, quoteMint, vaultA, vaultB,
  new PublicKey(pair.tokenProgram), pricing.curve.baseDecimals, plan.nom, plan.symbole, uri,
  { type: "ConstantCurve", supply: new BN(pricing.curve.supply), totalSellA: new BN(pricing.curve.totalSellA),
    totalFundRaisingB: new BN(pricing.raise.raw), migrateType: "cpmm" },
  new BN(0), new BN(0), new BN(0), // pas de vesting
  pricing.curve.cpmmCreatorFeeOn,
  plan.taxe ? { transferFeeBasePoints: plan.taxe, maxinumFee: new BN(TAXE_PLAFOND_BRUT) } : undefined,
  undefined, // pas de platformAllowConfig
  new PublicKey(pricing.curveRule[mode]),
);
const dernier = ix.keys[ix.keys.length - 1];
if (!dernier.pubkey.equals(new PublicKey(pricing.curveRule[mode])) || dernier.isWritable) throw new Error("règle de courbe mal placée");
if (!ix.keys[11].pubkey.equals(new PublicKey(pair.tokenProgram))) throw new Error("programme du jeton de paire mal placé");

const instructions = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: UNITES_CALCUL }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIX_UNITE_MICROLAMPORTS }),
  ix,
];
let recuEstime = 0n;
// Montant de l'achat en unités brutes de l'actif de la paire : lamports pour SOL, sinon la sortie de la conversion.
let montantB = plan.achatSol > 0 ? (estSol ? BigInt(Math.round(plan.achatSol * 1e9)) : (reprise ?? BigInt(devis.outAmount))) : 0n;
let conversion = null;
// Actif de la paire déjà détenu (conversion d'une tentative précédente) : on le réutilise au lieu de reconvertir.
const dejaDetenu = reprise != null;
if (dejaDetenu) {
  montantB = reprise;
  conversion = { reutilise: true, sortie: montantB.toString(), impact: 0, simulation: "inutile, actif déjà détenu" };
  if (cmd === "envoyer") noter({ id: plan.id, statut: "actif déjà détenu, conversion sautée", mint: mint.toBase58(), recu: montantB.toString(), paire: pair.symbol });
}
if (cmd === "simuler" && devis && !dejaDetenu) {
  const c = await conversionSimulee(payeur);
  conversion = { simulation: (c.sim.value.err ? "ÉCHEC " + JSON.stringify(c.sim.value.err) : "RÉUSSIE") + ` (tentative ${c.tentative}/${TENTATIVES_CONVERSION})`, sortie: devis.outAmount, impact: +devis.priceImpactPct * 100 };
}
if (cmd === "envoyer" && devis && !dejaDetenu) {
  // La conversion d'abord, dans sa propre transaction : simulée, signée, confirmée, puis on relit ce qu'on a vraiment reçu.
  const ataQuote = getAssociatedTokenAddressSync(quoteMint, payeur, false, programmeB);
  const avant = await soldeJeton(ataQuote);
  const c = await conversionSimulee(payeur);
  const simC = c.sim;
  if (simC.value.err) {
    noter({ id: plan.id, statut: "abandon : conversion non simulable", mint: mint.toBase58(), erreur: JSON.stringify(simC.value.err) });
    console.log("RESULTAT " + JSON.stringify({ plan: plan.id, statut: "abandon : conversion non simulable", simulation: JSON.stringify(simC.value.err) }));
    process.exit(2);
  }
  c.tx.sign([createurKp]);
  const sigC = await connection.sendTransaction(c.tx, { skipPreflight: false, maxRetries: 3 });
  noter({ id: plan.id, statut: "conversion envoyée", mint: mint.toBase58(), signature: sigC, sortieDevis: devis.outAmount, paire: pair.symbol });
  // Jupiter renvoie lastValidBlockHeight ; à défaut, ≈ 150 blocs de validité après la hauteur actuelle (≈ 1 minute).
  const hauteurMax = c.lastValidBlockHeight ?? (await connection.getBlockHeight("confirmed")) + 150;
  const confC = await connection.confirmTransaction({ signature: sigC, blockhash: c.tx.message.recentBlockhash, lastValidBlockHeight: hauteurMax }, "confirmed");
  if (confC.value.err) {
    noter({ id: plan.id, statut: "conversion échouée", mint: mint.toBase58(), signature: sigC, erreur: JSON.stringify(confC.value.err) });
    console.log("RESULTAT " + JSON.stringify({ plan: plan.id, statut: "conversion échouée", signature: sigC, simulation: JSON.stringify(confC.value.err) }));
    process.exit(2);
  }
  let apres = avant;
  for (let i = 0; i < 5 && apres <= avant; i++) { await sleep(1500); apres = await soldeJeton(ataQuote); }
  montantB = apres - avant;
  if (montantB <= 0n) throw new Error("conversion confirmée mais aucun " + pair.symbol + " reçu : arrêt avant la création");
  noter({ id: plan.id, statut: "conversion confirmée", mint: mint.toBase58(), signature: sigC, recu: montantB.toString(), paire: pair.symbol });
  conversion = { signature: sigC, sortie: montantB.toString(), impact: +devis.priceImpactPct * 100 };
}
// L'achat entre dans la transaction de création, sauf en simulation d'une paire non-SOL : on ne détient pas encore l'actif.
const achatDansLaTransaction = plan.achatSol > 0 && (estSol || cmd === "envoyer" || dejaDetenu);
if (plan.achatSol > 0) {
  const vA = BigInt(pricing.curve.derived.virtualA), vB = BigInt(pricing.curve.derived.virtualB);
  const net = (montantB * BigInt(Math.round((1 - FRAIS_COURBE) * 1e4))) / 10000n;
  recuEstime = ((vA * net) / (vB + net) * BigInt(10000 - plan.taxe)) / 10000n; // la taxe de transfert nous touche aussi
}
if (achatDansLaTransaction) {
  const minA = (recuEstime * BigInt(Math.round(MARGE_ACHAT * 100))) / 100n;
  const ataA = getAssociatedTokenAddressSync(mint, payeur, false, TOKEN_2022_PROGRAM_ID);
  const ataB = getAssociatedTokenAddressSync(quoteMint, payeur, false, programmeB);
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(payeur, ataA, payeur, mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payeur, ataB, payeur, quoteMint, programmeB),
  );
  if (estSol) instructions.push(
    SystemProgram.transfer({ fromPubkey: payeur, toPubkey: ataB, lamports: montantB }),
    createSyncNativeInstruction(ataB, TOKEN_PROGRAM_ID),
  );
  instructions.push(buyExactInInstruction(
    programId, payeur, auth, configId, platformId, poolId, ataA, ataB, vaultA, vaultB, mint, quoteMint,
    TOKEN_2022_PROGRAM_ID, programmeB,
    getPdaPlatformVault(programId, platformId, quoteMint).publicKey,
    getPdaCreatorVault(programId, createur, quoteMint).publicKey,
    new BN(montantB.toString()), new BN(minA.toString()),
  ));
  if (estSol) instructions.push(createCloseAccountInstruction(ataB, payeur, payeur, [], TOKEN_PROGRAM_ID));
}

// 6. Simulation obligatoire, dans les deux modes. En vrai, un échec de simulation arrête tout avant la moindre signature.
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
const message = new TransactionMessage({ payerKey: payeur, recentBlockhash: blockhash, instructions }).compileToV0Message();
const tx = new VersionedTransaction(message);
const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
const part = Number(recuEstime) / Number(pricing.curve.supply);
const resume = {
  plan: plan.id, code: plan.code, paire: pair.symbol, mode, taxe: plan.taxe, achatSol: plan.achatSol, mint: mint.toBase58(),
  soldeSol: solde / 1e9, partOffre: +(part * 100).toFixed(3), simulation: sim.value.err ? JSON.stringify(sim.value.err) : "réussie",
  unites: sim.value.unitsConsumed ?? null, departUsd: Math.round(pricing.marketCap.startUsd), graduationUsd: Math.round(pricing.marketCap.graduationUsd),
};
if (cmd === "simuler") {
  console.log(`paire ${pair.symbol} (${pair.categoryLabel}) · mode ${mode}${plan.taxe ? ` ${plan.taxe / 100} %` : ""} · plan ${plan.id} · code ${plan.code}`);
  console.log(`courbe : départ ≈ ${resume.departUsd} $, graduation ≈ ${resume.graduationUsd} $ · payeur ${payeur.toBase58()} · solde ${resume.soldeSol} SOL`);
  if (conversion) console.log(`conversion : ${plan.achatSol} SOL → ${(Number(conversion.sortie) / 10 ** pair.decimals).toLocaleString("fr-FR")} ${pair.symbol} · impact ${conversion.impact.toFixed(2)} % · simulation de la conversion : ${conversion.simulation}`);
  if (plan.achatSol > 0) console.log(`achat de départ ${plan.achatSol} SOL → ≈ ${(Number(recuEstime) / 1e6).toLocaleString("fr-FR")} tokens, ≈ ${resume.partOffre} % de l'offre${achatDansLaTransaction ? "" : " (achat simulé seulement après la vraie conversion)"}`);
  console.log(`simulation : ${sim.value.err ? "ÉCHEC " + resume.simulation : "RÉUSSIE"} · unités de calcul ${resume.unites ?? "?"}`);
  for (const l of (sim.value.logs ?? []).slice(-4)) console.log("  " + l.slice(0, 160));
  process.exit(sim.value.err ? 2 : 0);
}
if (sim.value.err) {
  noter({ id: plan.id, statut: "abandon : simulation échouée", mint: mint.toBase58(), erreur: resume.simulation, logs: (sim.value.logs ?? []).slice(-6) });
  console.log("RESULTAT " + JSON.stringify({ ...resume, statut: "abandon : simulation échouée" }));
  process.exit(2);
}

// 7. Signature (notre portefeuille + la clé jetable du token), envoi, renvois, confirmation.
let statut = "expiré ou inconnu", signature = null;
for (let essai = 1; essai <= TENTATIVES_ENVOI && statut === "expiré ou inconnu"; essai++) {
  const bh = essai === 1 ? { blockhash, lastValidBlockHeight } : await connection.getLatestBlockhash("confirmed");
  const txE = essai === 1 ? tx : new VersionedTransaction(new TransactionMessage({ payerKey: payeur, recentBlockhash: bh.blockhash, instructions }).compileToV0Message());
  txE.sign([createurKp, mintKp]);
  const brut = txE.serialize();
  signature = await connection.sendRawTransaction(brut, { skipPreflight: false, maxRetries: 0 });
  noter({ id: plan.id, statut: "envoyé", mint: mint.toBase58(), signature, essai });
  while (true) {
    await sleep(2000);
    const st = (await connection.getSignatureStatuses([signature])).value[0];
    if (st?.err) { statut = "échoué"; noter({ id: plan.id, statut, mint: mint.toBase58(), signature, taxe: plan.taxe, erreur: JSON.stringify(st.err) }); break; }
    if (st && ["confirmed", "finalized"].includes(st.confirmationStatus)) { statut = "confirmé"; noter({ id: plan.id, statut, mint: mint.toBase58(), signature, taxe: plan.taxe, essai }); break; }
    if ((await connection.getBlockHeight("confirmed")) > bh.lastValidBlockHeight) {
      // Dernière vérification avant de reconstruire : le token existe-t-il malgré tout ?
      if (await connection.getAccountInfo(mint, "confirmed")) { statut = "confirmé"; noter({ id: plan.id, statut, mint: mint.toBase58(), signature, taxe: plan.taxe, essai, note: "trouvé à l'expiration" }); }
      else noter({ id: plan.id, statut: "expiré", mint: mint.toBase58(), signature, essai });
      break;
    }
    try { await connection.sendRawTransaction(brut, { skipPreflight: true, maxRetries: 0 }); } catch {}
  }
}
if (statut === "expiré ou inconnu") noter({ id: plan.id, statut, mint: mint.toBase58(), signature, note: `${TENTATIVES_ENVOI} tentatives expirées` });

// 8. Adoption par StonkFun : le lancement doit apparaître dans leur registre (GET /launches?creator=…), qui est le signal
//    documenté. (23/09/2026) GET /tokens/{mint} répond « No platform pool exists » pour TOUS les lancements LaunchLab récents,
//    même adoptés : s'y fier a fait déclarer « non adopté » notre essai-1 alors qu'il l'était 3 min 30 après sa création.
let adopte = false;
if (statut === "confirmé") {
  const fin = Date.now() + ATTENTE_ADOPTION_MS;
  while (Date.now() < fin && !adopte) {
    await sleep(20_000);
    try { const d = await get(`/launches?creator=${createur.toBase58()}&pageSize=10`); adopte = (d?.launches ?? []).some((l) => l.mint === mint.toBase58()); } catch {}
  }
  noter({ id: plan.id, statut: adopte ? "adopté" : "non adopté", mint: mint.toBase58(), signature, taxe: plan.taxe });
}
console.log("RESULTAT " + JSON.stringify({ ...resume, statut, adopte, signature, image: imageUrl, uri, conversion,
  solscan: `https://solscan.io/tx/${signature}`, dexscreener: `https://dexscreener.com/solana/${mint.toBase58()}` }));
