import type { Context, DdcGatherItems } from "jsr:@shougo/ddc-vim@~9.4.0/types";
import { BaseSource } from "jsr:@shougo/ddc-vim@~9.4.0/source";

import type { Denops } from "jsr:@denops/core@~7.0.0";
import * as fn from "jsr:@denops/std@~7.5.0/function";
import * as op from "jsr:@denops/std@~7.5.0/option";
import * as vars from "jsr:@denops/std@~7.5.0/variable";

import { TextLineStream } from "jsr:@std/streams@~1.0.3/text-line-stream";
import { is } from "jsr:@core/unknownutil@~4.3.0/is";

type Params = {
  envs: Record<string, string>;
  shell: string;
};

const isEnvs = is.RecordObjectOf(is.String);

export class Source extends BaseSource<Params> {
  #completer?: (cmdline: string) => Promise<string[]>;
  #cmdlinePattern = /^(silent!?\s+)?([0-9,.%$]*!|terminal!?\s+)/;

  override async onInit(args: {
    denops: Denops;
    sourceParams: Params;
  }) {
    const { denops } = args;
    const { shell, envs } = args.sourceParams;

    if (!shell || !is.String(shell)) {
      await this.#printError(denops, `Invalid param: shell`);
      return;
    }
    if (!isEnvs(envs)) {
      await this.#printError(denops, `Invalid param: envs`);
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

    if (!capture) {
      await this.#printError(denops, `Not supported shell: ${shell}`);
      return;
    }

    const command = new Deno.Command(
      shell,
      {
        args: [capture],
        stdout: "piped",
        stderr: "piped",
        stdin: "piped",
        cwd: await fn.getcwd(denops) as string,
        env: {
          // Merge environment variables.
          // This is necessary to ensure that the shell has access to the same
          // environment as Vim.
          ...await fn.environ(denops) as Record<string, string>,
          ...envs,
        },
      },
    );

    let proc: Deno.ChildProcess;
    try {
      proc = command.spawn();
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        this.#printError(denops, `Command not found: ${shell}`);
      } else {
        this.#printError(denops, `Failed to spawn process: ${e}`);
      }
      return;
    }

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
            } else {
              this.#printError(denops, `${shell}: ${chunk}`);
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

    const dispose = () => {
      this.#completer = undefined;
      eofWaiter?.resolve([]);
      eofWaiter = undefined;
      try {
        proc.kill();
      } catch {
        // Prevent error if already stopped
      }
    };

    // Clean up resources after the process ends
    Promise.race([proc.status, stdout, stderr])
      .catch(() => {/* Prevent unhandled rejection */})
      .finally(async () => {
        if (this.#completer) {
          dispose();
          await this.#printError(denops, `Worker process terminated`);
        }
      });

    // Clean up resources when Denops is interrupted
    denops.interrupted?.addEventListener("abort", () => {
      dispose();
      this.isInitialized = false;
    });
  }

  override getCompletePosition(args: {
    context: Context;
  }): Promise<number> {
    const matchPos = args.context.input.search(/\S*$/);
    let completePos = matchPos !== null ? matchPos : -1;

    // For shell command completion in command line
    const cmdlineMatch = this.#cmdlinePattern.exec(args.context.input);
    if (args.context.mode === "c" && cmdlineMatch?.index !== undefined) {
      completePos = cmdlineMatch.index + cmdlineMatch[0].length;
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

    // For shell command completion in command line
    const cmdlineMatch = this.#cmdlinePattern.exec(input);
    if (args.context.mode === "c" && cmdlineMatch?.index !== undefined) {
      input = input.slice(cmdlineMatch.index + cmdlineMatch[0].length);
    }

    // Process collected lines
    const items = (await completer(input))
      .filter((line) => line.length > 0 && !line.startsWith("input="))
      .map((line) => {
        line = line.replace(/\/\/$/, "/"); // Replace the last //
        const [word, info] = line.split("\t", 2);
        return info ? { word, info } : { word };
      });

    return items;
  }

  override params(): Params {
    return {
      envs: {},
      shell: "",
    };
  }

  async #printError(denops: Denops, message: string): Promise<void> {
    await denops.call(
      "ddc#util#print_error",
      message,
      `ddc-source-${this.name}`,
    );
  }
}
