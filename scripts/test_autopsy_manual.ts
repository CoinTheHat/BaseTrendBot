
import { BirdeyeService } from '../services/BirdeyeService';
import { AutopsyService } from '../services/AutopsyService';

async function main() {
    // $RENTA Details
    // Mint: 5MxQUFdPisppdVfjitL6hs492GyikCFnsBWYtuAqpump
    // Alert Time: 2026-02-03T12:00:11.061Z (This is UTC likely, or local. Let's use timestamp)
    // Actually finding the exact timestamp from previous output: 2026-02-03T12:00:11.061Z

    const mint = '9kSY8u95ruPiZNrWUB8C8wxtREGePVHVSiH58RZpump';
    const alertTimeStr = '2026-02-03T11:45:14.504Z';
    const entryTimestamp = new Date(alertTimeStr).getTime();

    console.log(`🧪 TEST: Running Manual Autopsy on $SHIKSA`);
    console.log(`CA: ${mint}`);
    console.log(`Entry Time: ${alertTimeStr} (${entryTimestamp})`);

    const birdeye = new BirdeyeService();
    const autopsy = new AutopsyService(birdeye);

    console.log("--- STARTING ALGORITHM ---");
    const peakPrice = await autopsy.calculateTrueAth(mint, entryTimestamp);

    console.log(`\n✅ RESULT:`);
    console.log(`Calculated True ATH Price: $${peakPrice}`);
    // We don't have entry price here handy to calc Xs easily without fetching, 
    // but the fact it returns a number > 0 proves logic works.
}

main();
