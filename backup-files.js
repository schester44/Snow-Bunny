require('dotenv').config()
const fs = require("fs")
const argv = require('yargs').argv
const { promisify } = require('util')
const { resolve } = require('path')
const AWS = require('aws-sdk')
const pLimit = require('p-limit')
const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')
const { union } = require('lodash')
const ProgressBar = require('progress');




const DEFAULT_CONCURRENT_UPLOADS = 5
const DEFAULT_DB = 'db'

const filesToBackup = argv._[0]
const vaultName = typeof argv.vault === 'string' ? argv.vault : argv._[1]
const maxConcurrentUploads = !isNaN(argv.limit) ? parseInt(argv.limit) : DEFAULT_CONCURRENT_UPLOADS
const dbName = typeof argv.db === 'string' ? argv.db : DEFAULT_DB

const shouldLoadFirst = !!argv.load

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_REGION) {
    throw new Error('Missing required AWS .env variables')
}

const adapter = new FileSync(`${dbName}.json`)
const db = low(adapter)

db.defaults({ filesUploaded: [], filesToUpload: [], totalUploaded: 0 }).write()


const glacier = new AWS.Glacier({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
})

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile)

async function getFiles(dir) {
    const subdirs = await readdir(dir)

    const files = await Promise.all(subdirs.map(async (subdir) => {
        const res = resolve(dir, subdir);
        return (await stat(res)).isDirectory() ? getFiles(res) : res;
    }));
    return files.reduce((a, f) => a.concat(f), []);
}

const createProgressBar = (total) => {
    return new ProgressBar(':bar :current/:total :percent', { head: "$", width: 10, total });
}

const uploadFile = async (filePath, vaultName) => {
    return new Promise(async (resolve, reject) => {

        const fileInDatabase = db.get('filesUploaded').find({ filePath }).value()

        if (fileInDatabase) {
            // TODO: this could be moved to the loadFiles function
            db.get('filesToUpload').pull(filePath).write()
            return resolve({ error: 'file already exists', filePath, isExisting: true })
        }

        let file

        try {
            console.log('reading', filePath)

            file = await readFile(filePath)
        } catch (err) {
            console.log('error reading the file', filePath)
            return resolve({
                error: 'error reading the file',
                filePath,
                err
            })
        }


        const partSize = 1024 * 1024 // 1MB chunks
        let numPartsLeft = Math.ceil(file.length / partSize)
        const startTime = new Date()
        const params = { vaultName, partSize: partSize.toString() }

        const treeHash = glacier.computeChecksums(file).treeHash;

        const progressBar = createProgressBar(numPartsLeft)

        console.log('Starting upload for', filePath)

        // Call Glacier to initiate the upload.
        glacier.initiateMultipartUpload(params, function (mpErr, multipart) {
            if (mpErr) {
                reject({
                    filePath,
                    error: 'An error occurred while initiating the upload',
                    err: mpErr
                })
            }

            for (let i = 0; i < file.length; i += partSize) {
                const end = Math.min(i + partSize, file.length);

                const partParams = {
                    vaultName: vaultName,
                    uploadId: multipart.uploadId,
                    range: 'bytes ' + i + '-' + (end - 1) + '/*',
                    body: file.slice(i, end)
                };

                glacier.uploadMultipartPart(partParams, function (multiErr, mData) {
                    progressBar.tick()

                    if (multiErr) {
                        progressBar.terminate()
                        
                        resolve({
                            filePath,
                            error: 'An error occurred while completing the archive upload',
                            err: multiErr
                        })
                    }


                    if (--numPartsLeft > 0) return; // complete only when all parts uploaded

                    const doneParams = {
                        vaultName: vaultName,
                        uploadId: multipart.uploadId,
                        archiveSize: file.length.toString(),
                        checksum: treeHash // the computed tree hash
                    };

                    glacier.completeMultipartUpload(doneParams, function (err, data) {
                        if (err) {
                            console.log("An error occurred while uploading the archive");
                            console.log(err);

                            progressBar.terminate()

                            resolve({
                                filePath,
                                error: 'An error occurred while completing the archive upload',
                                err
                            })
                        } else {
                            const delta = (new Date() - startTime) / 1000;
                            console.log('Completed upload in', delta, 'seconds', filePath);

                            const details = {
                                filePath,
                                archiveId: data.archiveId,
                                checksum: data.checksum
                            }

                            // add this entry to filesUploaded
                            db.get('filesUploaded').push(details).write()

                            // remove this entry from the files to upload
                            db.get('filesToUpload').pull(filePath).write()

                            db.update('totalUploaded', n => n + 1).write()

                            resolve({ ...details, isUploaded: true })
                        }
                    });
                });
            }
        });
    })
}


async function loadFiles(filePath) {
    const files = await getFiles(filePath)
    const alreadyLoadedFiles = db.get('filesToUpload').value()

    const filesToUpload = union(files, alreadyLoadedFiles)

    console.log(`
        duplicate files: ${alreadyLoadedFiles.length}
        files loaded: ${filesToUpload.length}
        total files: ${files.length}
    `)

    return db.set('filesToUpload', filesToUpload).write()
}


// how many files to upload at once (concurrency)
const limit = pLimit(maxConcurrentUploads)


const run = async (filesToBackup, vaultName) => {
    if (shouldLoadFirst) {
        await loadFiles(filesToBackup)
    }

    if (!vaultName) {
        process.exit('No vault provided.')
    }

    const files = db.get('filesToUpload').value()

    const start = Date.now();

    const results = await Promise.all(files.map(filePath => {
        return limit(() => uploadFile(filePath, vaultName))
    }))

    const ms = Date.now() - start;

    const totalFilesUploaded = results.filter(({ isUploaded }) => !!isUploaded).length
    const totalExistingFiles = results.filter(({ isExisting }) => !!isExisting).length

    console.log(`Job finished
        total files: ${results.length}
        total time: ${ms / 1000} seconds
        uploads: ${totalFilesUploaded} of ${results.length} (${totalExistingFiles} already exist)
    `)
}


run(filesToBackup, vaultName)