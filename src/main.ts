import execa from 'execa'
import simpleGit from 'simple-git/promise'

const isSupportedExtension = (fileName: string): boolean => Boolean(fileName.match(/\.tsx?$/))

const findCommitAtWhichBranchForkedFromTargetBranch = (
  branch: string,
  targetBranch: string,
): Promise<string | undefined> =>
  execa('git', ['merge-base', '--fork-point', targetBranch, branch])
    .then((response) => response.stdout)
    .catch(() => undefined)

const findCommitAtWhichTheCurrentBranchForkedFromTargetBranch = async (
  targetBranch: string,
): Promise<string | undefined> => {
  return findCommitAtWhichBranchForkedFromTargetBranch('HEAD', targetBranch)
}

const findModifiedAndUntrackedFiles = async (): Promise<string[]> => {
  return simpleGit()
    .status()
    .then(({ created, modified, not_added }) => [...created, ...modified, ...not_added])
    .catch((e) => {
      console.warn('Can not find modified and untracked files', e)
      return []
    })
}

const findFilesFromDiffToRevision = async (
  baseRevision: string | undefined,
  childRevision: string,
): Promise<string[]> => {
  if (baseRevision === undefined) {
    return []
  }
  return simpleGit()
    .diffSummary([baseRevision, childRevision])
    .then(({ files }) => files.reduce((result, { file }) => [...result, file], [] as string[]))
    .catch((e) => {
      console.error('Can not find files that changed compared to master', e)
      return []
    })
}

const getTypeScriptCompileOutput = async (options: TypeScriptOptions): Promise<string[]> => {
  const args = Object.entries(options)
    .map(([key, value]) => [key.replace(/^/, '--'), value])
    .reduce<string[]>((result, [key, value]) => [...result, key, value], [])

  let tscOutput: string[] = []
  try {
    await execa('tsc', args)
  } catch (error) {
    const { all } = error
    tscOutput = (all as string).split('\n')
  }
  return tscOutput
}

export interface TypeScriptOptions {
  noImplicitAny: boolean
  noImplicitThis: boolean
  alwaysStrict: boolean
  strictBindCallApply: boolean
  strictNullChecks: boolean
  strictFunctionTypes: boolean
  strictPropertyInitialization: boolean
  noEmit: boolean
}

interface Args {
  typeScriptOptions: TypeScriptOptions
  targetBranch: string
  ignoreFilesChangedOnBranch: string[]
  onFoundSinceRevision: (revision: string | undefined) => void
  onFoundChangedFiles: (changedFiles: string[]) => void
  onExamineFile: (file: string) => void
  onCheckFile: (file: string, hasErrors: boolean) => void
}

interface StrictifyResult {
  success: boolean
  errors: number
}

export const strictify = async (args: Args): Promise<StrictifyResult> => {
  const {
    onFoundSinceRevision,
    onFoundChangedFiles,
    onCheckFile,
    typeScriptOptions,
    targetBranch,
    ignoreFilesChangedOnBranch,
  } = args

  const commit = await findCommitAtWhichTheCurrentBranchForkedFromTargetBranch(targetBranch)
  onFoundSinceRevision(commit)

  const excludedFiles = (await Promise.all(
    ignoreFilesChangedOnBranch.map((branchWithChangesToIgnore) =>
      findCommitAtWhichBranchForkedFromTargetBranch(branchWithChangesToIgnore, targetBranch).then(
        (baseCommit) => findFilesFromDiffToRevision(baseCommit, branchWithChangesToIgnore),
      ),
    ),
  )).reduce((accumulator, currentValue) => {
    return accumulator.concat(currentValue)
  })

  const changedFiles = await Promise.all([
    findModifiedAndUntrackedFiles(),
    findFilesFromDiffToRevision(commit, 'HEAD'),
  ]).then(([a, b]) => Array.from(new Set([...a, ...b])).filter(isSupportedExtension))
  onFoundChangedFiles(changedFiles)

  if (changedFiles.length === 0) {
    return { success: true, errors: 0 }
  }

  const includedChangedFiles = changedFiles.filter((changedFiles) => {
    return !excludedFiles.includes(changedFiles)
  })

  const tscOut = await getTypeScriptCompileOutput(typeScriptOptions)

  const errorCount = includedChangedFiles.reduce<number>((totalErrorCount, fileName) => {
    let errorCount = 0
    tscOut.map((line) => {
      if (line.includes(fileName)) {
        errorCount === 0 ? onCheckFile(fileName, true) : null
        totalErrorCount++
        errorCount++
        console.log(line)
      }
    })
    errorCount === 0 ? onCheckFile(fileName, false) : null
    return totalErrorCount
  }, 0)

  return {
    success: errorCount === 0,
    errors: errorCount,
  }
}
