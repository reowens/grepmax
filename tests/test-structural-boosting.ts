import { TreeSitterChunker } from "../src/lib/index/chunker";

async function testComplexity() {
  const chunker = new TreeSitterChunker();
  await chunker.init();

  const code = `
export function simple() {
  return 1;
}

export function complex() {
  if (true) {
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        console.log(i);
      }
    }
  }
  return 2;
}

function internal() {
  return 3;
}
  `;

  const { chunks, metadata } = await chunker.chunk("test.ts", code);
  console.log("Metadata exports:", metadata.exports);

  const simple = chunks.find((c) => c.content.includes("function simple"));
  const complex = chunks.find((c) => c.content.includes("function complex"));
  const internal = chunks.find((c) => c.content.includes("function internal"));

  console.log("Simple complexity:", simple?.complexity);
  console.log("Simple exported:", simple?.isExported);

  console.log("Complex complexity:", complex?.complexity);
  console.log("Complex exported:", complex?.isExported);

  console.log("Internal complexity:", internal?.complexity);
  console.log("Internal exported:", internal?.isExported);

  if ((complex?.complexity || 0) > (simple?.complexity || 0)) {
    console.log("✅ Complexity calculation works");
  } else {
    console.error("❌ Complexity calculation failed");
  }

  if (simple?.isExported && complex?.isExported && !internal?.isExported) {
    console.log("✅ Export detection works");
  } else {
    console.error("❌ Export detection failed");
  }
}

testComplexity().catch(console.error);
