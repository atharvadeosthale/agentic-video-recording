import { defineScenario } from "../src/index.js";

const url = new URL("./demo-site/index.html", import.meta.url).href;

export default defineScenario(
  { name: "keys", keys: { mode: "all" } },
  async (s) => {
    await s.goto(url);
    await s.startRecording();
    await s.wait(400);
    await s.type("#name", "hello world", { wpm: 180 });
    await s.press("Control+A");
    await s.press("Backspace");
    await s.wait(300);
    await s.type(null, "agentic", { wpm: 200 });
    await s.press("Enter");
    await s.press("Escape");
    await s.wait(1500);
    await s.stopRecording();
  },
);
