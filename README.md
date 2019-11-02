CLI for backing up files to S3 Glacier

## Getting Started
`npm i`

Create a .env file in the same dir as backup-files.js 
Add the following variables to the .env file, add the appropriate values for each variable.

```
AWS_ACCESS_KEY_ID = ""
AWS_SECRET_ACCESS_KEY = ""
AWS_REGION = ""
```


## Usage

```bash
node backup-files.js <path-to-backup> --vault <name-of-glacier-vault> --load
```

If you're backing up a specific path for the first time, you should call `--load` which will read all files within the directory and add the file paths to a local database.
The script will then read from that database and try to upload the given files. Once uploaded, the filepath will be removed from the database and the Glacier archive ID will be added.

You _should_ only need to call --load on a directory once... unless you've added new files to the directory.

This logic probably needs to be better but it works for my current use case. Basically i'm trying to cache a list of files and only upload them once. The script should be smart enough to skip any existing files by checking the DB for the file path. It's not intelligent enough yet to do any hash checking or similar.


This script reads the entire file into memory using fs.readFile to create a buffer that can be used for multi-part file uploads. If memory issues occur, you can pass the `--limit` flag to limit the number of concurrent uploads eg: `backup-files.js /my-dir --vault my-vault --limit 1`

## TODO
- Its quite possible that this doesn't work on large files of 2Gb or greater due to NodeJS's buffer limitations. 