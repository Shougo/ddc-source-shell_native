import type { Context, DdcGatherItems } from "jsr:@shougo/ddc-vim@~9.4.0/types";
import { BaseSource } from "jsr:@shougo/ddc-vim@~9.4.0/source";

import type { Denops } from "jsr:@denops/core@~7.0.0";
import * as fn from "jsr:@denops/std@~7.5.0/function";
import * as op from "jsr:@denops/std@~7.5.0/option";
import * as vars from "jsr:@denops/std@~7.5.0/variable";

import { TextLineStream } from "jsr:@std/streams@~1.0.3/text-line-stream";

type Params = {
  envs: Record<string, string>;
  shell: string;
};

export class Source extends BaseSource<Params> {
  #completer?: (cmdline: string) => Promise<string[]>;

  override async onInit(args: {
    denops: Denops;
    sourceParams: Params;
  }) {
    const { denops } = args;
    const { shell, envs } = args.sourceParams;
    if (shell === "" || await fn.executable(denops, shell) === 0) {
      return;
    }

    const runtimepath = await op.runtimepath.getGlobal(denops);
    const [capture] = await denops.call(
      "globpath",
      runtimepath,
      `bin/ddc-source-shell_native/capture.${shell}`,
      1,
      1,
    ) as string[];

    const proc = new Deno.Command(
      shell,
      {
        args: [capture],
        stdout: "piped",
        stderr: "piped",
        stdin: "piped",
        cwd: await fn.getcwd(denops) as string,
        env: envs,
      },
    ).spawn();

    const outputBuffer: string[] = [];
    let eofWaiter: PromiseWithResolvers<string[]> | undefined;

    const stdout = proc.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream())
      .pipeTo(
        new WritableStream({
          write: (chunk: string) => {
            // Collect output lines
            outputBuffer.push(chunk);
          },
        }),
      );

    const stderr = proc.stderr
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream())
      .pipeTo(
        new WritableStream({
          write: (chunk: string) => {
            // Wait until "EOF"
            if (chunk === "EOF") {
              // Move out buffered output lines
              const output = outputBuffer.splice(0);
              eofWaiter?.resolve(output);
            }
          },
        }),
      );

    const { writable, readable } = new TextEncoderStream();
    readable.pipeTo(proc.stdin);
    const cmdlineWriter = writable.getWriter();

    this.#completer = async (cmdline: string): Promise<string[]> => {
      if (!this.#completer) {
        return [];
      }

      // Wait for the previous completion to finish
      await eofWaiter?.promise;

      const { promise } = eofWaiter = Promise.withResolvers();
      cmdlineWriter.write(cmdline + "\n");
      return await promise;
    };

    // Clean up resources after the process ends
    Promise.allSettled([proc.status, stdout, stderr])
      .finally(() => {
        this.#completer = undefined;
        eofWaiter?.resolve([]);
        eofWaiter = undefined;
      });
  }

  override getCompletePosition(args: {
    context: Context;
  }): Promise<number> {
    const matchPos = args.context.input.search(/\S*$/);
    let completePos = matchPos !== null ? matchPos : -1;

    const completeStr = args.context.input.slice(completePos);
    // For ":!" completion in command line
    if (args.context.mode === "c" && completeStr.startsWith("!")) {
      completePos += 1;
    }

    return Promise.resolve(completePos);
  }

  override async gather(args: {
    denops: Denops;
    context: Context;
    completeStr: string;
    sourceParams: Params;
  }): Promise<DdcGatherItems> {
    const completer = this.#completer;
    if (!completer) {
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

    const delimiter = {
      zsh: " -- ",
      fish: "\t",
    }[args.sourceParams.shell] ?? "";

    // Process collected lines
    const items = (await completer(input)).map((line) => {
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
