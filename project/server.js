// Importing libraries and modules
const express = require('express'); // handle HTTP requests
const axios = require('axios');  // making HTTP requests to external services
const cheerio = require('cheerio'); // parsing and manipulating HTML
const ejs = require('ejs') 
const bodyParser = require('body-parser') // parsing incoming request bodies
const cors = require('cors'); // integrating applications 
const mysql = require('mysql2/promise'); 
const fs = require('fs'); // handle file operations
const csvParser = require('csv-parser'); 
require('dotenv').config() 

const app = express();  

// Server configuration
const port = process.env.PORT || 3001;  
app.use(cors()); 
app.use(express.json()); 
app.use(bodyParser.urlencoded({ extended: false })) 

// Setting up path and views for EJS
const path = require('path');
app.set('views', path.join(__dirname, 'views')); // set the directory where views are stored
app.use(express.static(path.join(__dirname, 'public'))); // serve static files from the public directory
app.set('view engine','ejs') // set EJS as template engine

// CSV file path configuration and stream creation
//const csvFilePath = process.env.CSV_PATH || path.join(__dirname, 'courseCode.csv'); // define the CSV file path
const csvFilePath = path.join(__dirname, 'courseCode.csv');
const fileStream = fs.createReadStream(csvFilePath); // create a readable stream from the CSV file  (read chunk of file not whole memory effective!)

const golfFinderApiKey = process.env.golfFinderApiKey;
const geocodingApiKey = process.env.geocodingApiKey;


fileStream.on('error', (err) => {
    console.error('Error reading the CSV file:', err.message); // error handling for file stream
});


// Database configuration
const db = {
    database: "golfcourse_data", 
    host: process.env.STACKHERO_MARIADB_HOST || "127.0.0.1",
    user: "root",
    password: process.env.STACKHERO_MARIADB_ROOT_PASSWORD || "thfdk69", 
    port: 3306
};


// Create a pool to manage connections to the database
const pool = mysql.createPool(db);

//checks if a golf course already exists in the database.
async function golfCourseExists(courseName) {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.query("SELECT 1 FROM golf_courses WHERE course_name = ?", [courseName]);
        return rows.length > 0; // returns true if course exists, otherwise false
    } catch (error) {
        console.error("Failed to check if golf course exists:", error);
        return false;
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

//inserts a new golf course into the database. 
async function insertGolfCourseData(courseInfo) {
    if (!courseInfo || !courseInfo.Golfcourse_Name) {
        console.error("Invalid course info provided.");
        return;
    }
    // Check if golf course already exists
    const exists = await golfCourseExists(courseInfo.Golfcourse_Name);
    if (exists) {
        console.log(`Golf course "${courseInfo.Golfcourse_Name}" already exists. Skipping insertion.`);
        return;
    }
    let connection;
    try {
        // Establish a database connection from the pool
        connection = await pool.getConnection();
        await connection.beginTransaction();
        
        // Insert the golf course information into the database
        for (let i = 0; i < courseInfo.Course_Rating.length; i++) {
            const teeName = courseInfo.Course_Rating[i].teeName;
            const rating = courseInfo.Course_Rating[i].rating;
            const slopeRating = courseInfo.Course_SlopeRating[i].slopeRating;

            await connection.query(
                "INSERT INTO golf_courses (course_name, rating, slope_rating) VALUES (?, ?, ?)",
                [courseInfo.Golfcourse_Name, `${teeName} ${rating}`, `${teeName} ${slopeRating}`]
            );
        }

        // Commit the transaction
        await connection.commit();
        console.log(`Data for "${courseInfo.Golfcourse_Name}" inserted successfully into db`);  
        
    } catch (error) {
        // Rollback the transaction on error
        if (connection) {
            await connection.rollback();
        }
        console.error("Failed to insert data into the database:", error);
    } finally {
        // Release the database connection
        if (connection) {
            connection.release();
        }
    }
}


let existingCourseNames = new Set();

// Fetch all existing course names and store in the Set
async function fetchExistingCourses() {
    try {
        const results = await pool.query("SELECT course_name FROM golf_courses");
        for (let row of results) {
            existingCourseNames.add(row.course_name);
        }
        console.log("Course inserting is done.");
    } catch (error) {
        console.error("Failed to fetch existing courses:", error);
    }
}


// Fetch the HTML content from the URL
const getHTML = async (keyword) => { 
    try {
        const response = await axios.get(`https://ncrdb.usga.org/courseTeeInfo?CourseID=${keyword}`);
        console.log(response);
        return response.data;
    } catch (e) {
        console.error("Error making Axios request:", e.response?.status, e.response?.statusText);
        return null;
    }
};


// Function to get golf course info from the USGA website 
async function getGolfCourseInfo(keyword) {
    const html = await getHTML(keyword);
    if (!html) {
        console.error("Failed to fetch HTML data from the website.");
        return null;
    }
    try {
        const $ = cheerio.load(html);
        const golfCourseName = $("#gvCourseTees > tbody > tr:nth-child(2) > td.tableCellWidth").text().trim();

        // Extract the tee names, course ratings, and slope ratings separately
        const teeNames = [];
        const courseRatings = [];
        const slopeRatings = [];
        
        $("#gvTee > tbody > tr").each((index, element) => {
            const teeName = $(element).find("td:nth-child(1)").text().trim();
            const courseRating = parseFloat($(element).find("td:nth-child(4)").text().trim());
            const slopeRating = parseFloat($(element).find("td:nth-child(5)").text().trim());

            // Handle NaN values or parsing errors
            teeNames.push(teeName);
            courseRatings.push(isNaN(courseRating) ? 0 : courseRating);
            slopeRatings.push(isNaN(slopeRating) ? 0 : slopeRating);
        });
        // Create an array of objects with the extracted information
        const courseInfo = {
            Golfcourse_Name: golfCourseName,
            Course_Rating: teeNames.map((teeName, index) => ({ teeName, rating: courseRatings[index] })),
            Course_SlopeRating: teeNames.map((teeName, index) => ({ teeName, slopeRating: slopeRatings[index] })),
        };
        return courseInfo;

    } catch (error) {
        console.error("Error processing HTML data for keyword:", keyword, error);
        return null;
    }    
}


const golfCourseKeywords = [];
let lineCount = 0; // variable to track the current line number

fileStream
    .pipe(csvParser())
    .on('data', (row) => {
        lineCount++;
        if (lineCount < 464) return; // * Skip lines before 397 데이터 추가할때!!

        const keyword = row.keyword; // Ensure 'keyword' matches the CSV header exactly
        if (keyword && keyword.trim()) {
            // Check if course does not exist in our Set
            if (!existingCourseNames.has(keyword)) {
                golfCourseKeywords.push(keyword);
            }
        }
    })
    .on('end', async () => {  
        if (golfCourseKeywords.length === 0) {
            //console.log('No valid keywords found. Exiting.');
            return;
        }
        async function main() {
            for (const keyword of golfCourseKeywords) {
                try {
                    await new Promise(resolve => setTimeout(resolve, 2000)); // delay to prevent rate limiting or overloading
        
                    // Fetch course data using the keyword
                    const courseInfo = await getGolfCourseInfo(keyword);
                    
                    if (!courseInfo) {
                        console.log(`No data returned for keyword: ${keyword}`);
                        continue; // skip if no course info returned
                    }
                    // Try to insert the data
                    try {
                        await insertGolfCourseData(courseInfo);
                    } catch (insertError) {
                        console.error(`Error inserting data for keyword "${keyword}":`, insertError);
                    }
                } catch (error) {
                    console.error(`Error processing keyword "${keyword}":`, error);
                }
            }
        }
        main();   
    })
    .on('error', (err) => {
        console.error('Error reading CSV file:', err);
    });
    

    async function getCoordinatesFromAddress(location) {
        const geocodingUrl = 'https://maps.googleapis.com/maps/api/geocode/json';
        try {
            const response = await axios.get(geocodingUrl, 
            { params: { 
                address: location, 
                components: "country:US",  // Corrected typo from 'componets' to 'components'
                key: geocodingApiKey
            }});
    
            // Check if the API response is successful
            if (response.data.status !== 'OK') {
                throw new Error(`Location not found or API key issue. Status: ${response.data.status}`);
            }
    
            // Extract the latitude and longitude from the first result
            const { lat, lng } = response.data.results[0].geometry.location;
            console.log(`Latitude: ${lat}, Longitude: ${lng}`);
            return { lat, lng };
        } catch (error) {
            console.error('Error fetching geocoding data:', error.message);
            throw error;
        }
    }
    

async function getNearbyGolfCourses(lat, lng) {
    const golfFinderUrl = 'https://golf-course-finder.p.rapidapi.com/api/golf-clubs/';
    try {
        // Validate the latitude and longitude
        if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
            console.error('Invalid latitude or longitude:', lat, lng);
            throw new Error('Invalid latitude or longitude provided.');
        }

        // Perform the API request
        const response = await axios.get(golfFinderUrl, {
            params: { 
                latitude: lat, 
                longitude: lng, 
                miles: 10 // Adjust the radius as needed
            },
            headers: {
                'x-rapidapi-key': process.env.golfFinderApiKey,
                'x-rapidapi-host': 'golf-course-finder.p.rapidapi.com'
            }
        });
        
        // Log the raw response data for debugging
        //console.log('API Response:', response.data);

        // Check the API response structure and extract golf club names
        if (!response.data||response.data===0) {
            console.log('No golf courses found or the API response structure is incorrect');
            return [];
        }

        const clubName = response.data.map(club=>club.club_name); // Accessing nested golf_courses array
        console.log('Fetched golf course names from Golf Finder API:', clubName);
        return clubName;
    } catch (error) {
        console.error('Error fetching data from Golf Finder API:', error.response ? error.response.data : error.message);
        throw error;
    }
}



async function fetchGolfCourseDetails(courseNames) {
    if (courseNames.length === 0) {
        console.log("No course names to search for.");
        return []; // Return an empty array if there are no course names
    }
    try {
        const sanitizedCourseNames = courseNames.map(name => name.trim().toLowerCase());
        console.log('Sanitized course names:', sanitizedCourseNames);
        
        const query = `
            SELECT 
                a.api_course_id,
                a.course_id,
                m.api_course_name,
                c.course_name,
                c.rating,
                c.slope_rating
            FROM 
                api_to_golf_courses a
            JOIN 
                golf_course_mappings m ON a.api_course_id = m.api_course_id
            JOIN 
                golf_courses c ON a.course_id = c.course_id
            WHERE 
                m.api_course_name IN (?);
        `;
        
        const [results] = await pool.query(query, [sanitizedCourseNames]);
        console.log('Fetched golf course details:', results);
        
        return results;
    } catch (error) {
        console.error("Error fetching golf course details:", error);
        throw error;
    }
}


// Add an interceptor to catch and log errors globally
axios.interceptors.response.use(
    (response) => response,
    (error) => {
        console.error('Error fetching data:', error);
        return Promise.reject(error);
    }
);


//Routing
app.get('/search', async (req, res) => {
    try {
        const location = req.query.location;
        if (!location) {
            console.error('Location query parameter is required.');
            return res.status(400).send('Location query parameter is required.');
        }
        const { lat, lng } = await getCoordinatesFromAddress(req.query.location);
        const courseNames = await getNearbyGolfCourses(lat, lng);
        const detailedCourseInfo = await fetchGolfCourseDetails(courseNames);

        res.json(detailedCourseInfo);
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).send('Error fetching data.');
    }
});


app.get('/', function (req, res) {
    res.render('index')  // ./views/index.ejs 불러와서 출력  Render the index.ejs view when the root URL is accessed
})

app.get('/ranking', function (req, res) { //// Render the ranking.ejs view when '/ranking' URL is accessed
    res.render('ranking')  
})

app.get('/home', function (req, res) {
    res.render('home')  
})

app.get('/contact', function (req, res) {
    res.render('contact') 
})

app.get('/result', function (req, res) {
    res.render('result') 
})

app.get('/SouthernCali', function (req, res) {
    res.render('SouthernCali') 
})

app.get('/NorthernCali', function (req, res) {
    res.render('NorthernCali') 
})

app.listen(port)
