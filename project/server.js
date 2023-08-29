const express = require('express');
const axios = require('axios'); 
const cheerio = require('cheerio');
const app = express();
const ejs = require('ejs')
const bodyParser = require('body-parser')

const cors = require('cors'); 
const mysql = require('mysql2/promise');
const fs = require('fs'); 
const csvParser = require('csv-parser');

const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
require('dotenv').config()

const path = require('path');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine','ejs')
app.use(bodyParser.urlencoded({ extended: false }))

const csvFilePath = process.env.CSV_PATH || path.join(__dirname, 'courseCode.csv');
const fileStream = fs.createReadStream(csvFilePath);

fileStream.on('error', (err) => {
    console.error('Error reading the CSV file:', err.message);
});

const db = {
    database: "golfcourse_data", // default to "golfcourse_data" if not set
    host: process.env.STACKHERO_MARIADB_HOST || "127.0.0.1",
    user: "root",
    password: process.env.STACKHERO_MARIADB_ROOT_PASSWORD || "thfdk69", // Please remove this default password for security reasons
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


//inserts a new golf course into the database. It first checks if the course already exists, and if not, 
//it inserts the course ratings and slope ratings into the database.
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

        // Begin a transaction
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



// fetch the HTML content from url 
const getHTML = async (keyword) => { 
    try {
        const html = await axios.get(`https://ncrdb.usga.org/courseTeeInfo.aspx?CourseID=${keyword}`);
        return html.data;
    } catch (e) {
        console.error("Error making Axios request:", e.response.status, e.response.statusText);
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
    try{
        const $ = cheerio.load(html);

        const golfCourseName = $("#gvCourseTees > tbody > tr:nth-child(2) > td:nth-child(1)").text().trim();

        // Extract the tee names, course ratings, and slope ratings separately
        const teeNames = [];
        const courseRatings = [];
        const slopeRatings = [];
        for (let i = 2; i <= 26; i++) {
            const teeName = $(`#gvTee > tbody > tr:nth-child(${i}) > td:nth-child(1)`).text().trim();
            const courseRating = parseFloat($(`#gvTee tr:nth-child(${i}) td:nth-child(4)`).text().trim());
            const slopeRating = parseFloat($(`#gvTee > tbody > tr:nth-child(${i}) > td.GVPadding.dtPadding.ratingsStyleItems`).text().trim());

            // Handle NaN values or parsing errors
        if (isNaN(courseRating)) {
            courseRatings.push(0); // Use a default value of 0 for invalid ratings
        } else {
            courseRatings.push(courseRating);
        }

        if (isNaN(slopeRating)) {
            slopeRatings.push(0); // Use a default value of 0 for invalid ratings
        } else {
            slopeRatings.push(slopeRating);
        }
        teeNames.push(teeName);
        }
        // Create an array of objects with the extracted information
        const courseInfo = {
            Golfcourse_Name: golfCourseName,
            Course_Rating: teeNames.map((teeName, index) => ({ teeName, rating: courseRatings[index] })),
            Course_SlopeRating: teeNames.map((teeName, index) => ({ teeName, slopeRating: slopeRatings[index] })),
        };
        // const courseNamesUSGA = courseInfo.Golfcourse_Name;
        // console.log('All USGA course names:', courseNamesUSGA);
        return courseInfo;

    } catch (error) {
        console.error("Error processing HTML data for keyword:", keyword, error);
        return null;
    }    
};

const golfCourseKeywords = [];
let lineCount = 0; // variable to track the current line number
    
fs.createReadStream(csvFilePath)
    .pipe(csvParser())
    .on('data', (row) => {
        lineCount++;
        if (lineCount < 397) return; // * Skip lines before 170 데이터 추가할때!!

        const keyword = row.Keyword;
        // Check if course does not exist in our Set
        if (!existingCourseNames.has(keyword)) {
            golfCourseKeywords.push(keyword);
        }
    })
    .on('end', async () => {  
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
    });



//Routing
//API key

const golfFinderApiKey = '234b53b3ccmshb82c7579628c603p1da094jsn811e7646403a'
const apiKey = '40b6c60e-5176-4733-b670-0b3e539e1ae3';
const courseId = '141520658891108829';
const geocodingApiKey = 'AIzaSyDxp3pJu2sISavqnPqunkK5FgaTvpqkKdA';
app.get('/search', async (req, res) => {
    try {
        const { lat, lng } = await getCoordinatesFromAddress(req.query.location);
        const courseNames = await getNearbyGolfCourses(lat, lng);

        // Fetch additional details from your DB
        const detailedCourseInfo = await fetchGolfCourseDetails(courseNames);

        console.log(detailedCourseInfo);

        res.json(detailedCourseInfo);
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).send('Error fetching data.');
    }
});

async function getCoordinatesFromAddress(location) {
    const geocodingUrl = 'https://maps.googleapis.com/maps/api/geocode/json';
    const response = await axios.get(geocodingUrl, { params: { address: location, key: geocodingApiKey } });
    const results = response.data.results;
    
    if (!results || results.length === 0) {
        throw new Error('Location not found.');
    }

    return results[0].geometry.location;
}

async function getNearbyGolfCourses(lat, lng) {
    const golfFinderUrl = 'https://golf-course-finder.p.rapidapi.com/courses';
    const response = await axios.get(golfFinderUrl, {
        params: { lat, lng, radius: 5 },
        headers: {
            'X-RapidAPI-Key': golfFinderApiKey,
            'X-RapidAPI-Host': 'golf-course-finder.p.rapidapi.com'
        },
    });

    const courses = response.data.courses || [];
    const courseNames = courses.map(course => course.name);
    return courseNames;
    console.log('Fetched course names from Golf Finder API:', courseNames);
}

async function fetchGolfCourseDetails(courseNames) {
    try {
        // SQL query to fetch details of golf courses that match with courseNames
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
        const sanitizedCourseNames = courseNames.map(name => name.trim().toLowerCase());
        console.log('Sanitized course names:', sanitizedCourseNames);
        const [results] = await pool.query(query, [sanitizedCourseNames]);
        // console.log('Query results:', results);
        // const [results] = await pool.query(query, [courseNames]);


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



app.get('/', function (req, res) {
    res.render('index')  // ./views/index.ejs 불러와서 출력
})

app.get('/ranking', function (req, res) {
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


// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//     console.log(`Server is running on port ${PORT}`);
// });

app.listen(port)

