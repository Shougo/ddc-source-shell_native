import type { Context, DdcGatherItems } from "jsr:@shougo/ddc-vim@~9.1.0/types";
import { BaseSource } from "jsr:@shougo/ddc-vim@~9.1.0/source";

import type { Denops } from "jsr:@denops/core@~7.0.0";
import * as fn from "jsr:@denops/std@~7.4.0/function";
import * as op from "jsr:@denops/std@~7.4.0/option";
import * as vars from "jsr:@denops/std@~7.4.0/variable";

import { TextLineStream } from "jsr:@std/streams@~1.0.3/text-line-stream";

type Params = {
  envs: Record<string, string>;
  shell: string;
};

export class Source extends BaseSource<Params> {
  #proc: Deno.ChildProcess | undefined;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;

  // Buffer for collecting output lines
  #outputBuffer: string[] = [];

  override async onInit(args: {
    denops: Denops;
    sourceParams: Params;
  }) {
    const shell = args.sourceParams.shell;
    if (shell === "" || await fn.executable(args.denops, shell) === 0) {
      return;
    }

    const runtimepath = await op.runtimepath.getGlobal(args.denops);
    const captures = await args.denops.call(
      "globpath",
      runtimepath,
      `bin/capture.${shell}`,
      1,
      1,
    ) as string[];

    this.#proc = new Deno.Command(
      args.sourceParams.shell,
      {
        args: [captures[0]],
        stdout: "piped",
        stderr: "piped",
        stdin: "piped",
        cwd: await fn.getcwd(args.denops) as string,
        env: args.sourceParams.envs,
      },
    ).spawn();

    this.#proc.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream())
      .pipeTo(
        new WritableStream({
          write: (chunk: string) => {
            this.#outputBuffer.push(chunk); // Collect output lines
          },
        }),
      ).finally(() => {
        this.#proc = undefined;
        this.#writer = undefined;
        this.#outputBuffer = [];
      });

    this.#writer = this.#proc.stdin.getWriter();
  }

  override getCompletePosition(args: {
    context: Context;
  }): Promise<number> {
    const matchPos = args.context.input.search(/\S*$/);
    const completePos = matchPos !== null ? matchPos : -1;
    return Promise.resolve(completePos);
  }

  override async gather(args: {
    denops: Denops;
    context: Context;
    completeStr: string;
    sourceParams: Params;
  }): Promise<DdcGatherItems> {
    if (!this.#proc || !this.#writer) {
      return [];
    }

    let input = args.context.input;
    if (args.context.mode !== "c") {
      const filetype = await op.filetype.getLocal(args.denops);
      const existsDeol = await fn.exists(args.denops, "*deol#get_input");
      if (filetype === "deol" && existsDeol) {
        input = await args.denops.call("deol#get_input") as string;
      }

      const uiName = await vars.b.get(args.denops, "ddt_ui_name", "");
      const existsDdt = await fn.exists(args.denops, "*ddt#get_input");
      if (uiName.length > 0 && existsDdt) {
        input = await args.denops.call("ddt#get_input", uiName) as string;
      }
    }

    // For ":!" completion in command line
    if (args.context.mode === "c" && input.startsWith("!")) {
      input = input.slice(1);
    }

    await this.#writer.write(new TextEncoder().encode(input + "\n"));

    // Wait for the output buffer to be populated
    // NOTE: Adjust timing if necessary
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Process collected lines
    const stdout = this.#outputBuffer.splice(0); // Copy and clear the buffer

    const delimiter = {
      zsh: " -- ",
      fish: "\t",
    }[args.sourceParams.shell] ?? "";

    const items = stdout.map((line) => {
      line = line.replace(/\/\/$/, "/"); // Replace the last //
      if (delimiter === "") {
        return { word: line };
      }
      const pieces = line.split(delimiter);
      return pieces.length <= 1
        ? { word: line }
        : { word: pieces[0], info: pieces[1] };
    });

    return items;
  }

  override params(): Params {
    return {
      envs: {},
      shell: "",
    };
  }
}
